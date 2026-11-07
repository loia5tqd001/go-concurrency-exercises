package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

type problem struct {
	rule string
	at   string // file, or file:line
	key  string // what an exception matches: "<rule> <exercise or file>"
	msg  string
}

// exceptions are known violations that existed when a rule was added. Each
// entry needs a reason. Delete an entry as soon as its violation is fixed
// (lint warns about entries that match nothing); never add one just to make
// a new violation pass.
var exceptions = map[string]string{
	"test-header 05-session-cleaner": "check_test.go predates the header; it has uncommitted edits in the owner's checkout",
	"browser 04-graceful-sigint":     "the lesson is OS signals; web/ marks it unsupported",
}

// docTestName matches a test function named in prose, like TestFoo or TestFoo_Bar.
var docTestName = regexp.MustCompile(`\bTest[A-Z][A-Za-z0-9_]*`)

// diagramChars marks a fenced block as an ASCII diagram rather than shell output.
var diagramChars = regexp.MustCompile(`[─│┌┐└┘├┤┬┴▶◀▼▲→←↓↑]|-->|<--|\+--`)

// browserUnsupported lists APIs the in-browser runner (GOOS=js, see web/)
// cannot back with real behavior.
var browserUnsupported = map[string]string{
	"os/exec":            "starts a child process",
	"os/signal":          "needs real OS signals",
	"os.Pipe":            "has no pipes",
	"runtime.NumCPU":     "always reports 1 CPU",
	"runtime.GOMAXPROCS": "always runs with GOMAXPROCS=1",
}

func runLint(args []string) error {
	fs := flag.NewFlagSet("lint", flag.ExitOnError)
	src := srcFlag(fs, "worktree")
	fs.Parse(args)
	t, err := openTree(*src)
	if err != nil {
		return err
	}
	defer t.close()
	if !report(lint(t), *src) {
		return failed{}
	}
	return nil
}

// report prints problems and returns whether the tree is clean.
func report(problems []problem, src string) bool {
	used := map[string]bool{}
	var real []problem
	for _, p := range problems {
		if _, ok := exceptions[p.key]; ok {
			used[p.key] = true
			continue
		}
		real = append(real, p)
	}
	for _, p := range real {
		fmt.Fprintf(os.Stderr, "%s: [%s] %s\n", p.at, p.rule, p.msg)
	}
	var stale []string
	for k := range exceptions {
		if !used[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	if src == "worktree" {
		// The owner's uncommitted fixes can make an exception look stale
		// here while HEAD still needs it; index and head runs report it.
		stale = nil
	}
	for _, k := range stale {
		fmt.Fprintf(os.Stderr, "warning: exception %q in tools/check/lint.go matches nothing; delete it\n", k)
	}
	if len(real) > 0 {
		fmt.Fprintf(os.Stderr, "\nlint (%s): %d problem(s). Fix each one; the rules are explained in AGENTS.md.\n", src, len(real))
		return false
	}
	fmt.Printf("lint (%s): ok\n", src)
	return true
}

func lint(t *tree) []problem {
	var ps []problem
	add := func(rule, at, subject, format string, args ...any) {
		ps = append(ps, problem{rule: rule, at: at, key: rule + " " + subject, msg: fmt.Sprintf(format, args...)})
	}
	has := map[string]bool{}
	for _, f := range t.files {
		has[f] = true
	}
	exs := exercises(t)
	byID := map[string]exercise{}
	byNum := map[string]exercise{}
	for _, ex := range exs {
		byID[ex.id] = ex
		byNum[ex.num] = ex
	}

	// layout: the files every exercise needs, and nothing else.
	for _, ex := range exs {
		for _, f := range []string{"README.md", "main.go", "check_test.go"} {
			if !has[ex.id+"/"+f] {
				add("layout", ex.id+"/"+f, ex.id, "missing; every exercise has README.md, main.go, and check_test.go")
			}
		}
		if !has["solutions/"+ex.id+".md"] {
			add("layout", "solutions/"+ex.id+".md", ex.id, "missing; every exercise has a worked solution doc named after its folder")
		}
	}
	for _, f := range t.files {
		dir, name, ok := strings.Cut(f, "/")
		if !ok {
			continue
		}
		if _, isEx := byID[dir]; isEx && name != "README.md" && (strings.Contains(name, "/") || !strings.HasSuffix(name, ".go")) {
			add("layout", f, f, "unexpected file in an exercise folder (only README.md and .go files belong here); if it is build output, delete it and make sure .gitignore covers it")
		}
		if dir == "solutions" && name != "README.md" {
			if _, isEx := byID[strings.TrimSuffix(name, ".md")]; !isEx {
				add("layout", f, f, "no exercise folder %q; rename the doc when you rename the folder", strings.TrimSuffix(name, ".md"))
			}
		}
	}

	// Go files: package, gofmt, browser support. In the working tree, an
	// exercise .go file with local changes is the owner's work in progress
	// (usually a solution), so only its test names are collected; the
	// commit gate checks whatever of it gets staged.
	ownerWIP := map[string]bool{}
	if t.src == "worktree" {
		if wip, err := gitFiles(t.root, "diff", "--name-only", "-z", "HEAD"); err == nil {
			for _, f := range wip {
				ownerWIP[f] = exerciseOf(f) != ""
			}
		}
	}
	tests := map[string]map[string]bool{} // exercise id -> test func names
	for _, f := range t.files {
		if !strings.HasSuffix(f, ".go") {
			continue
		}
		dir, _, _ := strings.Cut(f, "/")
		_, isEx := byID[dir]
		if !isEx && dir != "tools" {
			continue
		}
		src, err := t.read(f)
		if err != nil {
			add("gofmt", f, f, "%v", err)
			continue
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, f, src, parser.ParseComments)
		if err == nil && strings.HasSuffix(f, "_test.go") {
			if tests[dir] == nil {
				tests[dir] = map[string]bool{}
			}
			for _, d := range file.Decls {
				if fn, ok := d.(*ast.FuncDecl); ok && fn.Recv == nil && strings.HasPrefix(fn.Name.Name, "Test") {
					tests[dir][fn.Name.Name] = true
				}
			}
		}
		if ownerWIP[f] {
			continue
		}
		if isEx && file != nil {
			ps = append(ps, commentLanguageProblems(f, fset, file, dir)...)
		}
		if formatted, err := format.Source(src); err != nil {
			add("gofmt", f, f, "does not parse: %v", err)
			continue
		} else if !bytes.Equal(formatted, src) {
			add("gofmt", f, f, "not gofmt-formatted; run gofmt -w %s", f)
		}
		if !isEx || file == nil {
			continue
		}
		if file.Name.Name != "main" {
			add("package", f, dir, "package %s; every exercise file is package main", file.Name.Name)
		}
		for _, imp := range file.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if why, bad := browserUnsupported[p]; bad {
				add("browser", fmt.Sprintf("%s:%d", f, fset.Position(imp.Pos()).Line), dir,
					"imports %s, and the in-browser runner %s; keep exercises runnable in web/ or mark the exercise unsupported there", p, why)
			}
		}
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if x, ok := sel.X.(*ast.Ident); ok {
				name := x.Name + "." + sel.Sel.Name
				if why, bad := browserUnsupported[name]; bad {
					add("browser", fmt.Sprintf("%s:%d", f, fset.Position(sel.Pos()).Line), dir,
						"uses %s, and the in-browser runner %s; do not depend on it in exercise code", name, why)
				}
			}
			return true
		})
	}

	for _, ex := range exs {
		// test-header: tells a solver which file is theirs to edit.
		if b, err := t.read(ex.id + "/check_test.go"); err == nil && !bytes.Contains(b, []byte("DO NOT EDIT THIS PART")) {
			add("test-header", ex.id+"/check_test.go", ex.id, "missing the \"DO NOT EDIT THIS PART\" header block that every other check_test.go starts with")
		}

		// readme: title, a diagram, and how to test.
		if b, err := t.read(ex.id + "/README.md"); err == nil {
			s := string(b)
			if !strings.HasPrefix(s, "# ") {
				add("readme-title", ex.id+"/README.md:1", ex.id, "must start with a \"# Title\" line")
			}
			if !hasHeading(s, "test your solution") {
				add("readme-test-section", ex.id+"/README.md", ex.id, "needs a \"## Test your solution\" section with the go test commands")
			}
			if !hasDiagram(s) {
				add("readme-diagram", ex.id+"/README.md", ex.id, "needs an ASCII diagram of the today-vs-goal shape in a plain ``` block (see 36-batch-collector/README.md)")
			}
		}

		// doc-tests: a test named in prose must exist, or the doc is stale.
		for _, doc := range []string{ex.id + "/README.md", "solutions/" + ex.id + ".md"} {
			b, err := t.read(doc)
			if err != nil {
				continue
			}
			for _, name := range uniq(docTestName.FindAllString(string(b), -1)) {
				if !tests[ex.id][name] {
					add("doc-tests", doc, doc, "names %s, but %s has no such test; update the doc to match check_test.go", name, ex.id)
				}
			}
		}

		// solutions doc: spoiler banner first.
		if b, err := t.read("solutions/" + ex.id + ".md"); err == nil && !bytes.Contains(b, []byte("Spoiler warning")) {
			add("solution-doc", "solutions/"+ex.id+".md", ex.id, "needs the \"> **Spoiler warning.**\" banner under its title")
		}
	}

	// viz-diagram: every numbered spec pins a plain fence in its exercise
	// README, so a diagram edit cannot leave the scenes telling the old story.
	// The pin is compared with the README this run checks. An index tree holds
	// the staged blobs (git checkout-index), so in the commit gate this is the
	// same bytes as `git show :<id>/README.md`; a pin that matches only an
	// unstaged README edit cannot reach the commit.
	for _, f := range t.files {
		name, ok := strings.CutPrefix(f, "web/src/viz/specs/")
		if !ok || strings.Contains(name, "/") || !strings.HasSuffix(name, ".ts") {
			continue
		}
		id := strings.TrimSuffix(name, ".ts")
		if id == "" || id[0] < '0' || id[0] > '9' {
			continue // _template.ts and shared modules carry no pin
		}
		ex, known := byID[id]
		if !known {
			add("viz-diagram", f, id, "spec for %q, which is not an exercise folder; name the spec after its exercise", id)
			continue
		}
		src, err := t.read(f)
		if err != nil {
			add("viz-diagram", f, id, "%v", err)
			continue
		}
		pins := specDiagramPins(string(src))
		if _, ok := pins["today"]; !ok {
			add("viz-diagram", f, id, "diagrams.today is missing; every Problem tier pins its README fence")
		}
		readme, err := t.read(id + "/README.md")
		if err != nil {
			add("viz-diagram", id+"/README.md", id, "no README to pin; every spec pairs with %s/README.md", id)
			continue
		}
		plain := plainFences(string(readme))
		var hashes []string
		for _, p := range plain {
			hashes = append(hashes, p.hash)
		}
		found := "none"
		if len(hashes) > 0 {
			found = strings.Join(hashes, ", ")
		}
		for _, tier := range []string{"today", "goal"} {
			pin, ok := pins[tier]
			if !ok {
				continue
			}
			if !diagramPinForm.MatchString(pin) {
				add("viz-diagram", f, id, "diagrams.%s %q is not an fnv1a pin (want fnv1a: and 8 lowercase hex digits)", tier, pin)
				continue
			}
			if slices.Contains(hashes, pin) {
				continue
			}
			add("viz-diagram", id+"/README.md", id,
				"no plain fence hashes to diagrams.%s %s; the plain fences hash to %s. The diagram changed, or the pin is stale: re-read the diagram, update the scenes if the story changed, then run `npm run viz -- pin %s`",
				tier, pin, found, ex.prefix)
		}
	}

	// overview: one well-formed row per exercise, in folder order.
	readme, err := t.read("README.md")
	if err != nil {
		add("overview", "README.md", "README.md", "%v", err)
		return ps
	}
	rows := overviewRows(string(readme))
	rowOf := map[string]row{}
	var order []string
	for _, r := range rows {
		if _, dup := rowOf[r.dir]; dup {
			add("overview", r.String(), r.dir, "second row for %s; keep exactly one", r.dir)
			continue
		}
		rowOf[r.dir] = r
		order = append(order, r.dir)
		ex, ok := byID[r.dir]
		if !ok {
			add("overview", r.String(), r.dir, "links ./%s, which is not an exercise folder", r.dir)
			continue
		}
		if r.num != ex.num {
			add("overview", r.String(), r.dir, "number column is %q; folder %s needs %q", r.num, r.dir, ex.num)
		}
		ti := tierIndex(r.difficulty)
		if ti < 0 {
			add("overview", r.String(), r.dir, "difficulty %q is not one of warm-up, easy, medium, hard, extreme", r.difficulty)
		} else if r.badge != tiers[ti].badge {
			add("overview", r.String(), r.dir, "badge URL for %s must be %s", r.difficulty, tiers[ti].badge)
		}
		if len(r.topics) == 0 {
			add("overview", r.String(), r.dir, "needs at least one `topic` tag")
		}
		for _, tp := range r.topics {
			if !topicName.MatchString(tp) {
				add("overview", r.String(), r.dir, "topic %q must be lowercase, like `sync.waitgroup` or `fan-out-fan-in`", tp)
			}
		}
		if len(uniq(r.topics)) != len(r.topics) {
			add("overview", r.String(), r.dir, "lists a topic twice")
		}
	}
	for _, ex := range exs {
		if _, ok := rowOf[ex.id]; !ok {
			add("overview", "README.md", ex.id, "no overview table row for %s; add one (see the \"Root README table\" section of .claude/skills/new-exercise/REFERENCE.md)", ex.id)
		}
	}
	var folders []string
	for _, ex := range exs {
		if _, ok := rowOf[ex.id]; ok {
			folders = append(folders, ex.id)
		}
	}
	var listed []string
	for _, d := range order {
		if _, ok := byID[d]; ok {
			listed = append(listed, d)
		}
	}
	if !slices.Equal(listed, folders) {
		add("overview", "README.md", "README.md", "overview rows are not in folder order; a lettered sequel goes right after its parent")
	}

	// sequel-tier: a lettered sequel is the same lesson, harder.
	for _, ex := range exs {
		if ex.parent == "" {
			continue
		}
		parent, ok := byNum[ex.parent]
		if !ok {
			add("sequel-tier", ex.id, ex.id, "lettered sequel has no parent exercise %s", ex.parent)
			continue
		}
		r, p := rowOf[ex.id], rowOf[parent.id]
		if tierIndex(r.difficulty) >= 0 && tierIndex(p.difficulty) >= 0 && tierIndex(r.difficulty) < tierIndex(p.difficulty) {
			add("sequel-tier", r.String(), ex.id, "%s is rated %s, below its parent %s (%s); a lettered sequel never rates easier than its parent", ex.id, r.difficulty, parent.id, p.difficulty)
		}
	}

	// generated: derived sections match the overview table.
	want, err := expected(t)
	if err != nil {
		add("generated", "README.md", "README.md", "%v", err)
	} else {
		for _, file := range []string{"README.md", "solutions/README.md"} {
			if cur, _ := t.read(file); string(cur) != want[file] {
				add("generated", file, file, "generated section is stale; edit only the overview table in README.md, then run `make gen`")
			}
		}
	}

	// skills: .agents/skills mirrors .claude/skills, so other agents load the same skills.
	skills := map[string]bool{}
	for _, f := range t.files {
		if rest, ok := strings.CutPrefix(f, ".claude/skills/"); ok {
			if name, file, ok := strings.Cut(rest, "/"); ok && file == "SKILL.md" {
				skills[name] = true
			}
		}
	}
	for name := range skills {
		link := ".agents/skills/" + name
		target, err := os.Readlink(t.path(link))
		if err != nil || target != "../../.claude/skills/"+name {
			add("skills", link, name, "must be a symlink to ../../.claude/skills/%s; run: ln -s ../../.claude/skills/%s %s", name, name, link)
		}
	}
	for _, f := range t.files {
		if rest, ok := strings.CutPrefix(f, ".agents/skills/"); ok {
			if name := strings.Split(rest, "/")[0]; !skills[name] {
				add("skills", f, name, "mirrors no skill in .claude/skills; delete it")
			}
		}
	}
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].at < ps[j].at })
	return ps
}

func hasHeading(md, text string) bool {
	for _, l := range strings.Split(md, "\n") {
		if strings.HasPrefix(l, "#") && strings.Contains(strings.ToLower(l), text) {
			return true
		}
	}
	return false
}

func hasDiagram(md string) bool {
	for _, f := range plainFences(md) {
		if diagramChars.MatchString(f.body) {
			return true
		}
	}
	return false
}

func uniq(s []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range s {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// exerciseOf returns the exercise folder a repo path lives in, or "".
func exerciseOf(p string) string {
	dir, _, ok := strings.Cut(path.Clean(p), "/")
	if ok && exerciseDir.MatchString(dir) {
		return dir
	}
	return ""
}
