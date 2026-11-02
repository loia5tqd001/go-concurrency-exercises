package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var failLine = regexp.MustCompile(`(?m)^\s*--- FAIL: (\S+)`)

// verdict is the outcome of checking one scaffold.
type verdict struct {
	id     string
	ok     bool
	detail string
}

func runScaffolds(args []string) error {
	fs := flag.NewFlagSet("scaffolds", flag.ExitOnError)
	src := srcFlag(fs, "index")
	runs := fs.Int("runs", 1, "run each test binary this many times; every run must fail")
	timeout := fs.Duration("timeout", 2*time.Minute, "a scaffold whose tests run longer than this counts as hanging")
	fs.Parse(args)
	t, err := openTree(*src)
	if err != nil {
		return err
	}
	defer t.close()
	ids, err := pick(t, fs.Args())
	if err != nil {
		return err
	}
	if !checkScaffolds(t, ids, *runs, *timeout) {
		return failed{}
	}
	return nil
}

// pick resolves exercise arguments ("36", "14b", or a folder name) to
// folders. With no arguments it returns every exercise, except that in the
// working tree it skips a main.go with local changes: that file is
// usually the owner's solution, which passes by design.
func pick(t *tree, args []string) ([]string, error) {
	exs := exercises(t)
	if len(args) == 0 {
		var ids, skipped []string
		for _, ex := range exs {
			if t.src == "worktree" && changedFromHEAD(t.root, ex.id+"/main.go") {
				skipped = append(skipped, ex.prefix)
				continue
			}
			ids = append(ids, ex.id)
		}
		if len(skipped) > 0 {
			fmt.Printf("skip %d exercise(s) whose main.go has local changes (the owner's solutions?): %s. Name one to check it anyway.\n", len(skipped), strings.Join(skipped, " "))
		}
		return ids, nil
	}
	var ids []string
	for _, a := range args {
		a = strings.TrimSuffix(filepath.Base(a), "/")
		found := ""
		for _, ex := range exs {
			if ex.id == a || ex.prefix == a || ex.num == a {
				found = ex.id
			}
		}
		if found == "" {
			return nil, fmt.Errorf("no exercise %q in the %s", a, t.src)
		}
		ids = append(ids, found)
	}
	return ids, nil
}

func changedFromHEAD(root, rel string) bool {
	cmd := exec.Command("git", "diff", "--quiet", "HEAD", "--", rel)
	cmd.Dir = root
	return cmd.Run() != nil
}

// checkScaffolds verifies the contract every committed main.go meets: it
// builds, passes go vet, and fails its own tests quickly. A scaffold that
// passes is either a solved main.go about to be published, or tests that
// do not catch the bug. A scaffold that hangs means a test waits on the
// solution without a timeout guard.
func checkScaffolds(t *tree, ids []string, runs int, timeout time.Duration) bool {
	if len(ids) == 0 {
		return true
	}
	pkgs := make([]string, len(ids))
	for i, id := range ids {
		pkgs[i] = "./" + id
	}
	vet := exec.Command("go", append([]string{"vet"}, pkgs...)...)
	vet.Dir = t.root
	if out, err := vet.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "FAIL go vet (%s):\n%s\n", t.src, out)
		return false
	}

	bin, err := os.MkdirTemp("", "check-bin-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return false
	}
	defer os.RemoveAll(bin)

	verdicts := make([]verdict, len(ids))
	sem := make(chan struct{}, max(1, runtime.NumCPU()/2))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			verdicts[i] = checkScaffold(t, id, filepath.Join(bin, id+".test"), runs, timeout)
		}()
	}
	wg.Wait()

	// Name each passing exercise only in a small run (make verify EX=36),
	// where the failing test names help. A full run prints failures and
	// one summary line, so it does not flood an agent's context.
	ok, passed := true, 0
	for _, v := range verdicts {
		if v.ok {
			passed++
			if len(verdicts) <= 3 {
				fmt.Printf("ok   %s: %s\n", v.id, v.detail)
			}
		} else {
			ok = false
			fmt.Fprintf(os.Stderr, "FAIL %s: %s\n", v.id, v.detail)
		}
	}
	if len(verdicts) > 3 {
		fmt.Printf("scaffolds (%s): %d of %d fail their tests as intended\n", t.src, passed, len(verdicts))
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "\nscaffolds (%s): a committed main.go must build and fail its own tests fast. See AGENTS.md.\n", t.src)
	}
	return ok
}

func checkScaffold(t *tree, id, bin string, runs int, timeout time.Duration) verdict {
	build := exec.Command("go", "test", "-c", "-trimpath", "-o", bin, "./"+id)
	build.Dir = t.root
	if out, err := build.CombinedOutput(); err != nil {
		return verdict{id, false, "does not build:\n" + indent(string(out))}
	}
	var failedTests []string
	var took time.Duration
	for run := 1; run <= runs; run++ {
		ctx, cancel := context.WithTimeout(context.Background(), timeout+30*time.Second)
		cmd := exec.CommandContext(ctx, bin, "-test.timeout="+timeout.String())
		cmd.Dir = t.path(id)
		start := time.Now()
		out, err := cmd.CombinedOutput()
		took = max(took, time.Since(start))
		killed := ctx.Err() != nil
		cancel()
		var exit *exec.ExitError
		switch {
		case err == nil:
			return verdict{id, false, fmt.Sprintf("tests PASS against this main.go (run %d of %d). Either it is a solution, which must never be committed, or check_test.go does not catch the bug.", run, runs)}
		case bytes.Contains(out, []byte("panic: test timed out")) || killed:
			return verdict{id, false, fmt.Sprintf("tests hang for %s instead of failing fast; guard each blocking call with select and time.After (see \"Fast-failing tests\" in .claude/skills/new-exercise/REFERENCE.md):\n%s", timeout, tail(string(out), 12))}
		case !errors.As(err, &exit):
			return verdict{id, false, "could not run the test binary: " + err.Error()}
		}
		for _, m := range failLine.FindAllStringSubmatch(string(out), -1) {
			failedTests = append(failedTests, m[1])
		}
		if len(failedTests) == 0 {
			// A runtime fatal error (02's concurrent map write) is a real
			// failure of the naive code, not of the harness.
			failedTests = append(failedTests, "crash: "+firstLine(string(out), "fatal error:", "panic:"))
		}
	}
	return verdict{id, true, fmt.Sprintf("fails as intended in %d/%d run(s), slowest %.1fs (%s)", runs, runs, took.Seconds(), strings.Join(uniq(failedTests), ", "))}
}

func runTry(args []string) error {
	fs := flag.NewFlagSet("try", flag.ExitOnError)
	race := fs.Bool("race", true, "run with the race detector")
	count := fs.Int("count", 20, "run the tests this many times")
	fs.Parse(args)
	if fs.NArg() != 2 {
		return fmt.Errorf("usage: go run ./tools/check try [-race] [-count=N] <exercise> <main.go>")
	}
	candidate, err := filepath.Abs(fs.Arg(1))
	if err != nil {
		return err
	}
	src, err := os.ReadFile(candidate)
	if err != nil {
		return err
	}
	t, err := openTree("worktree")
	if err != nil {
		return err
	}
	ids, err := pick(t, fs.Args()[:1])
	if err != nil {
		return err
	}
	id := ids[0]

	// Copy the module files and the exercise into a scratch module, so the
	// candidate never overwrites anyone's main.go. Tests that parse main.go
	// from disk (19, 38) see the candidate too.
	dir, err := os.MkdirTemp("", "check-try-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	copies := []string{"go.mod", "go.sum"}
	for _, f := range t.files {
		if strings.HasPrefix(f, id+"/") && f != id+"/main.go" {
			copies = append(copies, f)
		}
	}
	for _, f := range copies {
		b, err := t.read(f)
		if err != nil {
			return err
		}
		if err := writeFile(filepath.Join(dir, f), b); err != nil {
			return err
		}
	}
	if err := writeFile(filepath.Join(dir, id, "main.go"), src); err != nil {
		return err
	}

	testArgs := []string{"test", fmt.Sprintf("-count=%d", *count), "-timeout=10m"}
	if *race {
		testArgs = append(testArgs, "-race")
	}
	cmd := exec.Command("go", append(testArgs, "./"+id)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\nFAIL %s: %s does not pass %d run(s)%s.\n", tail(string(out), 40), id, fs.Arg(1), *count, raceNote(*race))
		return failed{}
	}
	fmt.Printf("ok   %s: %s passes %d run(s)%s\n", id, fs.Arg(1), *count, raceNote(*race))
	return nil
}

func raceNote(race bool) string {
	if race {
		return " with -race"
	}
	return ""
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return indent(strings.Join(lines, "\n"))
}

func indent(s string) string {
	return "    " + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n    ")
}

func firstLine(s string, prefixes ...string) string {
	for _, l := range strings.Split(s, "\n") {
		for _, p := range prefixes {
			if strings.HasPrefix(l, p) {
				return l
			}
		}
	}
	return "non-zero exit"
}
