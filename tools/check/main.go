// Command check enforces this repository's invariants. Each rule exists
// because an earlier change broke it; a failed rule says what to do next.
//
//	go run ./tools/check lint      [-src=worktree|index|head]
//	go run ./tools/check gen       rewrite the generated README sections
//	go run ./tools/check scaffolds [-src=index|worktree|head] [-runs=N] [exercise...]
//	go run ./tools/check try       [-race] [-count=N] <exercise> <main.go>
//	go run ./tools/check precommit (the git pre-commit hook)
//	go run ./tools/check hook edit|bash|stop (Claude Code hooks, JSON on stdin)
//
// -src picks which copy of the repo to check: the working tree, the git
// index (what the next commit will contain), or HEAD. The working tree of a
// maintainer's checkout holds solved main.go files, so commit-time checks
// read the index instead.
package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const usage = `usage: go run ./tools/check <command> [flags]

commands:
  lint       static rules: layout, README tables, docs, gofmt, browser support
  gen        rewrite the generated sections of README.md and solutions/README.md
  scaffolds  every scaffold must build, pass go vet, and fail its own tests fast
  try        run an exercise's tests against a candidate main.go, in a temp copy
  precommit  what the git pre-commit hook runs
  hook       Claude Code hooks (edit, bash, stop)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "lint":
		err = runLint(args)
	case "gen":
		err = runGen(args)
	case "scaffolds":
		err = runScaffolds(args)
	case "try":
		err = runTry(args)
	case "precommit":
		err = runPrecommit(args)
	case "hook":
		os.Exit(runHook(args))
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		var f failed
		if !errors.As(err, &f) {
			fmt.Fprintln(os.Stderr, "check:", err)
		}
		os.Exit(1)
	}
}

// failed is returned after a command has already printed its findings, so
// main exits non-zero without printing them a second time.
type failed struct{}

func (failed) Error() string { return "check failed" }

// tree is one copy of the repository: a directory plus the files in it that
// git would commit.
type tree struct {
	src   string
	root  string
	files []string // slash-separated, relative to root, sorted by git
	close func()
}

func (t *tree) path(rel string) string { return filepath.Join(t.root, filepath.FromSlash(rel)) }

func (t *tree) read(rel string) ([]byte, error) { return os.ReadFile(t.path(rel)) }

func (t *tree) exists(rel string) bool {
	_, err := os.Lstat(t.path(rel))
	return err == nil
}

func srcFlag(fs *flag.FlagSet, def string) *string {
	return fs.String("src", def, "which copy to check: worktree, index, or head")
}

func openTree(src string) (*tree, error) {
	root, err := repoRoot()
	if err != nil {
		return nil, err
	}
	switch src {
	case "worktree":
		// --others adds new files that are not ignored yet, so a new
		// exercise is checked before its first git add.
		files, err := gitFiles(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
		if err != nil {
			return nil, err
		}
		var present []string
		for _, f := range files {
			// A tracked file deleted from the working tree is still listed.
			if _, err := os.Lstat(filepath.Join(root, f)); err == nil {
				present = append(present, f)
			}
		}
		sort.Strings(present)
		return &tree{src: src, root: root, files: dedupe(present), close: func() {}}, nil
	case "index":
		dir, err := os.MkdirTemp("", "check-index-")
		if err != nil {
			return nil, err
		}
		cmd := exec.Command("git", "checkout-index", "--all", "--prefix="+dir+string(filepath.Separator))
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			os.RemoveAll(dir)
			return nil, fmt.Errorf("git checkout-index: %v\n%s", err, out)
		}
		files, err := gitFiles(root, "ls-files", "-z", "--cached")
		if err != nil {
			os.RemoveAll(dir)
			return nil, err
		}
		return &tree{src: src, root: dir, files: dedupe(files), close: func() { os.RemoveAll(dir) }}, nil
	case "head":
		dir, err := os.MkdirTemp("", "check-head-")
		if err != nil {
			return nil, err
		}
		if err := extractHEAD(root, dir); err != nil {
			os.RemoveAll(dir)
			return nil, err
		}
		files, err := gitFiles(root, "ls-tree", "-r", "-z", "--name-only", "HEAD")
		if err != nil {
			os.RemoveAll(dir)
			return nil, err
		}
		return &tree{src: src, root: dir, files: files, close: func() { os.RemoveAll(dir) }}, nil
	}
	return nil, fmt.Errorf("unknown -src %q: want worktree, index, or head", src)
}

func extractHEAD(root, dir string) error {
	cmd := exec.Command("git", "archive", "HEAD")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	tr := tar.NewReader(out)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(h.Name))
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(dst, 0o755)
		case tar.TypeSymlink:
			if err = os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
				err = os.Symlink(h.Linkname, dst)
			}
		case tar.TypeReg:
			if err = os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
				var f *os.File
				if f, err = os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o777); err == nil {
					_, err = io.Copy(f, tr)
					if cerr := f.Close(); err == nil {
						err = cerr
					}
				}
			}
		}
		if err != nil {
			return err
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("git archive HEAD: %v\n%s", err, stderr.Bytes())
	}
	return nil
}

func repoRoot() (string, error) {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("not inside a git repository: %v", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func git(root string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %v\n%s", strings.Join(args, " "), err, stderr.Bytes())
	}
	return string(out), nil
}

// gitFiles runs a git command that prints NUL-separated paths.
func gitFiles(root string, args ...string) ([]string, error) {
	out, err := git(root, args...)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, f := range strings.Split(out, "\x00") {
		if f != "" {
			files = append(files, f)
		}
	}
	return files, nil
}

func dedupe(sorted []string) []string {
	var out []string
	for i, s := range sorted {
		if i == 0 || s != sorted[i-1] {
			out = append(out, s)
		}
	}
	return out
}
