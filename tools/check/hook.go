package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

// runPrecommit checks what the next commit will contain: the git index, not
// the working tree. It refuses three failure shapes this repo has shipped
// before: stale staged content after `git mv` plus an edit, a solved
// main.go (it passes its tests), and docs or tables that drifted.
func runPrecommit(args []string) error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	staged, err := gitFiles(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD")
	if err != nil {
		return err
	}
	unstaged, err := gitFiles(root, "diff", "--name-only", "-z")
	if err != nil {
		return err
	}
	ok := true
	var partial []string
	for _, f := range staged {
		if slices.Contains(unstaged, f) {
			partial = append(partial, f)
		}
	}
	if len(partial) > 0 {
		ok = false
		fmt.Fprintln(os.Stderr, "These staged files also have unstaged edits, so the commit would ship an older version of them:")
		for _, f := range partial {
			fmt.Fprintln(os.Stderr, "    "+f)
		}
		fmt.Fprintln(os.Stderr, "Run `git add <file>` for each one to stage the current content. This often happens after `git mv` followed by an edit.")
		fmt.Fprintln(os.Stderr)
	}

	// The deployed site and the clone read git HEAD, while the local dev
	// server reads the working tree. A commit that touches an exercise but
	// leaves its README unstaged ships a page whose prose and diagram differ
	// from the one the author saw. Refuse only for the exercises this commit
	// touches: a global rule would block every unrelated commit while any
	// exercise README is in progress in the owner's checkout.
	touchedEx := map[string]bool{}
	for _, f := range staged {
		if ex := stagedExercise(f); ex != "" {
			touchedEx[ex] = true
		}
	}
	var readmeGaps []string
	for _, f := range unstaged {
		ex := exerciseOf(f)
		if ex != "" && strings.HasSuffix(f, "/README.md") && touchedEx[ex] {
			readmeGaps = append(readmeGaps, f)
		}
	}
	sort.Strings(readmeGaps)
	if len(readmeGaps) > 0 {
		ok = false
		fmt.Fprintln(os.Stderr, "This commit touches an exercise whose README has unstaged changes, so the deployed site and the clone would miss them:")
		for _, f := range readmeGaps {
			fmt.Fprintln(os.Stderr, "    "+f)
		}
		fmt.Fprintln(os.Stderr, "Run `git add <file>` for each one, so the README reaches the commit and the deployed site.")
		fmt.Fprintln(os.Stderr)
	}

	t, err := openTree("index")
	if err != nil {
		return err
	}
	defer t.close()
	if !report(lint(t), "index") {
		ok = false
	}

	touched := map[string]bool{}
	for _, f := range staged {
		if ex := exerciseOf(f); ex != "" && t.exists(ex+"/main.go") {
			touched[ex] = true
		}
	}
	ids := make([]string, 0, len(touched))
	for id := range touched {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if !checkScaffolds(t, ids, 1, 2*time.Minute) {
		ok = false
	}
	if !ok {
		fmt.Fprintln(os.Stderr, "\npre-commit: commit refused. Fix the problems above and commit again. Do not bypass this hook with --no-verify.")
		return failed{}
	}
	return nil
}

// stagedExercise returns the exercise id a staged path can change: a file
// under <id>/, the solution doc solutions/<id>.md, or the spec
// web/src/viz/specs/<id>.ts. Any other path belongs to no exercise.
func stagedExercise(f string) string {
	if ex := exerciseOf(f); ex != "" {
		return ex
	}
	for _, p := range []struct{ prefix, suffix string }{
		{"solutions/", ".md"},
		{"web/src/viz/specs/", ".ts"},
	} {
		id, ok := strings.CutPrefix(f, p.prefix)
		if !ok {
			continue
		}
		id, ok = strings.CutSuffix(id, p.suffix)
		if ok && exerciseDir.MatchString(id) {
			return id
		}
	}
	return ""
}

// hookInput is the JSON Claude Code sends to a hook on stdin.
type hookInput struct {
	SessionID      string `json:"session_id"`
	Cwd            string `json:"cwd"`
	StopHookActive bool   `json:"stop_hook_active"`
	ToolInput      struct {
		FilePath string `json:"file_path"`
		Command  string `json:"command"`
	} `json:"tool_input"`
}

// runHook implements the Claude Code hooks in .claude/settings.json. Exit
// code 2 blocks the action and shows stderr to the agent; any other failure
// lets the action through, so a broken checker never locks an agent out.
func runHook(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tools/check hook edit|bash|stop")
		return 1
	}
	var in hookInput
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "check hook:", err)
		return 1
	}
	root, err := repoRoot()
	if err != nil {
		return 0
	}
	var msg string
	switch args[0] {
	case "edit":
		msg = guardEdit(root, in)
	case "bash":
		msg = guardBash(root, in)
	case "stop":
		msg = guardStop(root, in)
	}
	if msg == "" {
		return 0
	}
	fmt.Fprintln(os.Stderr, msg)
	return 2
}

// touchedFile records the repo paths this session edited, so the edit
// guard can tell the owner's work from the agent's own earlier edits.
func touchedFile(session string) string {
	return filepath.Join(os.TempDir(), "go-concurrency-exercises-hooks", session+".touched")
}

func touched(session string) map[string]bool {
	set := map[string]bool{}
	f, err := os.Open(touchedFile(session))
	if err != nil {
		return set
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		set[s.Text()] = true
	}
	return set
}

func markTouched(session, rel string) {
	p := touchedFile(session)
	if os.MkdirAll(filepath.Dir(p), 0o755) != nil {
		return
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, rel)
}

// guardEdit stops an agent from overwriting the owner's uncommitted work in
// an exercise folder. Those files usually hold the owner's own solutions,
// and nothing else keeps a copy of them.
func guardEdit(root string, in hookInput) string {
	abs := in.ToolInput.FilePath
	if abs == "" || in.SessionID == "" {
		return ""
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	rel = filepath.ToSlash(rel)
	ex := exerciseOf(rel)
	if ex == "" || touched(in.SessionID)[rel] {
		markTouched(in.SessionID, rel)
		return ""
	}
	cur, err := os.ReadFile(abs)
	if err != nil {
		markTouched(in.SessionID, rel) // a new file: nothing to lose
		return ""
	}
	head, err := exec.Command("git", "-C", root, "show", "HEAD:"+rel).Output()
	if err != nil || string(head) == string(cur) {
		markTouched(in.SessionID, rel) // untracked, or no local changes
		return ""
	}
	backup := filepath.Join(root, ".wip-backup", filepath.FromSlash(rel))
	if b, err := os.ReadFile(backup); err == nil && string(b) == string(cur) {
		markTouched(in.SessionID, rel)
		return ""
	}
	return fmt.Sprintf(`Blocked: %s has uncommitted changes that this session did not make. In an exercise folder these are usually the owner's own solution, and no other copy exists.

Do not overwrite it unless the task needs this exact file changed. If it does:
  1. Back it up:  mkdir -p .wip-backup/%s && cp %s .wip-backup/%s
  2. Retry the edit. The guard allows it once the backup matches.
  3. When your change is committed, restore the owner's copy:  cp .wip-backup/%s %s
.wip-backup/ is git-ignored.`, rel, ex, rel, rel, rel, rel)
}

// guardBash refuses git commands that would destroy or publish the owner's
// uncommitted work, or skip the commit gate. The owner can still run any
// of them by typing "! <command>" in the prompt.
func guardBash(root string, in hookInput) string {
	for _, seg := range segments(in.ToolInput.Command) {
		if reason := gitRisk(root, in.Cwd, seg); reason != "" {
			return "Blocked: " + reason + "\nIf the owner explicitly wants this, ask them to run it as \"! <command>\" in the prompt."
		}
	}
	return ""
}

// segments splits a shell command into simple commands, each a list of
// words with quotes removed. It is not a full shell parser; it only needs
// to find git invocations and their flags.
func segments(cmd string) [][]string {
	var segs [][]string
	var words []string
	var w strings.Builder
	inWord := false
	flush := func() {
		if inWord {
			words = append(words, w.String())
			w.Reset()
			inWord = false
		}
	}
	end := func() {
		flush()
		if len(words) > 0 {
			segs = append(segs, words)
			words = nil
		}
	}
	var quote rune
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				w.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote, inWord = r, true
		case r == '\\' && i+1 < len(rs):
			i++
			w.WriteRune(rs[i])
			inWord = true
		case r == ';' || r == '&' || r == '|' || r == '\n' || r == '(' || r == ')':
			end()
		case r == ' ' || r == '\t':
			flush()
		default:
			w.WriteRune(r)
			inWord = true
		}
	}
	end()
	return segs
}

func gitRisk(root, cwd string, words []string) string {
	// Skip "VAR=value" prefixes and wrappers to find the program.
	for len(words) > 0 && (strings.Contains(words[0], "=") || words[0] == "command" || words[0] == "env" || words[0] == "sudo") {
		words = words[1:]
	}
	if len(words) == 0 || filepath.Base(words[0]) != "git" {
		return ""
	}
	i := 1
	for i < len(words) && strings.HasPrefix(words[i], "-") {
		if strings.Contains(words[i], "core.hooksPath") || words[i] == "-c" && i+1 < len(words) && strings.Contains(words[i+1], "core.hooksPath") {
			return "changing core.hooksPath turns off the commit gate in .githooks/."
		}
		if words[i] == "-C" || words[i] == "-c" {
			i++
		}
		i++
	}
	if i >= len(words) {
		return ""
	}
	sub, rest := words[i], words[i+1:]
	// shortHas reports whether a short flag group like -am holds letter. The
	// word after -m or -F is a message or file name, not flags.
	shortHas := func(letter string) bool {
		for k, a := range rest {
			if k > 0 && slices.Contains([]string{"-m", "-F", "-C", "-c", "-t"}, rest[k-1]) {
				continue
			}
			if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, letter) {
				return true
			}
		}
		return false
	}
	switch sub {
	case "add":
		for _, a := range rest {
			if a == "-A" || a == "--all" || a == "." || a == ":/" || a == "-u" || a == "--update" || a == "*" {
				return "`git add " + a + "` also stages the owner's local solutions (exercise main.go files) and build output. Stage each file by name; check `git status` first."
			}
		}
	case "commit":
		if slices.Contains(rest, "--no-verify") || slices.Contains(rest, "-n") {
			return "--no-verify skips the pre-commit gate (tools/check precommit). Fix what it reports instead."
		}
		if slices.Contains(rest, "--all") || shortHas("a") {
			return "`git commit -a` also commits the owner's local solutions. Stage each file by name, then commit without -a."
		}
	case "push":
		if slices.Contains(rest, "--no-verify") {
			return "--no-verify skips the repo's git hooks."
		}
		if slices.Contains(rest, "--force") || slices.Contains(rest, "-f") {
			return "a plain force push can drop commits made elsewhere. Use --force-with-lease, and only when the owner asked for a history rewrite."
		}
	case "reset":
		if slices.Contains(rest, "--hard") {
			return "`git reset --hard` deletes every uncommitted change, including the owner's solutions in exercise main.go files."
		}
	case "clean":
		if slices.Contains(rest, "--force") || shortHas("f") {
			return "`git clean -f` deletes untracked files, such as new exercises in progress and the owner's scratch folders."
		}
	case "stash":
		if len(rest) > 0 && (rest[0] == "drop" || rest[0] == "clear") {
			return "`git stash " + rest[0] + "` deletes stashed work for good."
		}
	case "config":
		for _, a := range rest {
			if strings.Contains(a, "core.hooksPath") {
				return "changing core.hooksPath turns off the commit gate in .githooks/."
			}
		}
	case "checkout", "restore":
		var paths []string
		if sub == "checkout" {
			if k := slices.Index(rest, "--"); k >= 0 {
				paths = rest[k+1:]
			} else if slices.Contains(rest, ".") {
				paths = []string{"."}
			}
		} else if !(slices.Contains(rest, "--staged") || slices.Contains(rest, "-S")) || slices.Contains(rest, "--worktree") || slices.Contains(rest, "-W") {
			for _, a := range rest {
				if !strings.HasPrefix(a, "-") {
					paths = append(paths, a)
				}
			}
		}
		if f := overwritesWIP(root, cwd, paths); f != "" {
			return fmt.Sprintf("`git %s` would overwrite %s, which has uncommitted changes (in an exercise folder, usually the owner's solution). Back it up to .wip-backup/ first, or restore only files without local changes.", sub, f)
		}
	}
	return ""
}

// overwritesWIP returns the first file with uncommitted changes that one of
// paths covers, or "".
func overwritesWIP(root, cwd string, paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	wip, err := gitFiles(root, "diff", "--name-only", "-z", "HEAD")
	if err != nil {
		return ""
	}
	if cwd == "" {
		cwd = root
	}
	for _, p := range paths {
		abs := p
		if !filepath.IsAbs(p) {
			abs = filepath.Join(cwd, p)
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			continue
		}
		rel = filepath.ToSlash(rel)
		for _, f := range wip {
			if rel == "." || f == rel || strings.HasPrefix(f, rel+"/") {
				return f
			}
		}
	}
	return ""
}

// guardStop keeps an agent from finishing while lint fails, if the agent
// edited the repo this session. It blocks once; stop_hook_active is set on
// the retry, so an agent that cannot fix the problem can still stop and
// report it.
func guardStop(root string, in hookInput) string {
	if in.StopHookActive || len(touched(in.SessionID)) == 0 {
		return ""
	}
	cmd := exec.Command("go", "run", "./tools/check", "lint")
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err == nil {
		return ""
	}
	// Cap the message: it lands in the agent's context, and the first
	// problems are enough to start on; `make lint` lists the rest.
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) > 25 {
		lines = append(lines[:25], fmt.Sprintf("... %d more lines; run `make lint` to see them all.", len(lines)-25))
	}
	return "Before you finish: `make lint` fails after your edits. Fix these problems, or tell the owner why you cannot:\n" + strings.Join(lines, "\n")
}
