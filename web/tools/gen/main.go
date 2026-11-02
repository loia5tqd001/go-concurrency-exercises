// Command gen writes the site's exercise data: an index bundled into the
// app (src/generated/exercises.json) and one lazily fetched JSON file per
// exercise (public/data/).
//
// It reads the repository's committed HEAD through `git archive`, never the
// working tree: a maintainer's checkout keeps solved main.go files locally,
// and those must not end up on the public site.
package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"unicode"
	"unicode/utf8"
)

var (
	exerciseDir = regexp.MustCompile(`^(\d{2}[a-z]?)-[a-z0-9-]+$`)
	// One row of the root README's overview table:
	// | 0 | [Limit your Crawler](./00-limit-crawler) | ![warm-up](badge) | `topic` `topic` |
	tableRow  = regexp.MustCompile(`^\|\s*\d+[a-z]?\s*\|\s*\[(.+?)\]\(\./([^)/]+)/?\)\s*\|\s*!\[([^\]]*)\][^|]*\|(.*)\|\s*$`)
	topicCode = regexp.MustCompile("`([^`]+)`")
	modLine   = regexp.MustCompile(`(?m)^module\s+(\S+)`)
	goLine    = regexp.MustCompile(`(?m)^go\s+(\d+\.\d+(?:\.\d+)?)`)
)

// unsupportedImports are packages GOOS=js cannot back with real behavior: a
// browser tab has no child processes and no OS signals.
var unsupportedImports = map[string]string{
	"os/exec":   "starts a child process",
	"os/signal": "needs real OS signals",
}

type File struct {
	Name     string `json:"name"`
	Content  string `json:"content"`
	Editable bool   `json:"editable"`
	Test     bool   `json:"test"`
}

// Exercise is the lazily fetched per-exercise payload.
type Exercise struct {
	ID       string   `json:"id"`
	Readme   string   `json:"readme"`
	Solution string   `json:"solution"`
	Files    []File   `json:"files"`
	TestMain string   `json:"testMain"`
	Tests    []string `json:"tests"`
}

// Summary is what the sidebar needs before any exercise is opened.
type Summary struct {
	ID         string   `json:"id"`
	Number     string   `json:"number"`
	Title      string   `json:"title"`
	Difficulty string   `json:"difficulty"`
	Topics     []string `json:"topics"`
	ImportPath string   `json:"importPath"`
	Data       string   `json:"data"`
	// Unsupported explains why the tests cannot run in a browser; empty
	// when they can.
	Unsupported string `json:"unsupported,omitempty"`
}

type Index struct {
	Module    string    `json:"module"`
	GoVersion string    `json:"goVersion"`
	Lang      string    `json:"lang"`
	Commit    string    `json:"commit"`
	RepoURL   string    `json:"repoUrl"`
	Home      string    `json:"home"`
	Exercises []Summary `json:"exercises"`
	// Imports is every package any exercise file imports; goassets makes
	// sure the in-browser stdlib bundle covers all of them.
	Imports []string `json:"imports"`
}

func main() {
	repo := flag.String("repo", "..", "repository root")
	indexOut := flag.String("index", "src/generated/exercises.json", "index output path")
	dataDir := flag.String("data", "public/data", "per-exercise data output directory")
	flag.Parse()

	if err := run(*repo, *indexOut, *dataDir); err != nil {
		log.Fatalf("gen: %v", err)
	}
}

func run(repo, indexOut, dataDir string) error {
	commit, err := git(repo, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("the site is built from committed files only, so it needs a git checkout "+
			"(on Vercel: deploy through the Git integration, or run `vercel build` locally and then "+
			"`vercel deploy --prebuilt`): %w", err)
	}
	commit = strings.TrimSpace(commit)

	tree, err := readHEAD(repo)
	if err != nil {
		return err
	}

	gomod, ok := tree["go.mod"]
	if !ok {
		return errors.New("no go.mod at the repository root")
	}
	module := submatch(modLine, gomod)
	goVersion := submatch(goLine, gomod)
	if module == "" || goVersion == "" {
		return errors.New("go.mod has no module path or go directive")
	}

	byDir := map[string]map[string]string{}
	for name, content := range tree {
		dir, base := path.Split(name)
		dir = strings.TrimSuffix(dir, "/")
		if !exerciseDir.MatchString(dir) {
			continue
		}
		if byDir[dir] == nil {
			byDir[dir] = map[string]string{}
		}
		byDir[dir][base] = content
	}

	meta := parseOverview(tree["README.md"])

	if err := os.RemoveAll(dataDir); err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}

	index := Index{
		Module:    module,
		GoVersion: goVersion,
		Lang:      "go" + strings.Join(strings.Split(goVersion, ".")[:2], "."),
		Commit:    commit,
		RepoURL:   "https://" + module,
	}

	index.Home, err = writeData(dataDir, "home", map[string]string{"readme": tree["README.md"]})
	if err != nil {
		return err
	}

	imports := map[string]bool{}
	ids := make([]string, 0, len(byDir))
	for id := range byDir {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return orderKey(ids[i], meta) < orderKey(ids[j], meta) })

	for _, id := range ids {
		ex, sum, err := buildExercise(id, byDir[id], module, imports)
		if err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
		ex.Solution = tree["solutions/"+id+".md"]
		if m, ok := meta[id]; ok {
			sum.Title, sum.Difficulty, sum.Topics = m.title, m.difficulty, m.topics
		} else {
			sum.Title = firstHeading(ex.Readme, id)
		}
		sum.Data, err = writeData(dataDir, id, ex)
		if err != nil {
			return err
		}
		index.Exercises = append(index.Exercises, sum)
	}

	for p := range imports {
		index.Imports = append(index.Imports, p)
	}
	sort.Strings(index.Imports)

	return writeJSON(indexOut, index)
}

func buildExercise(id string, files map[string]string, module string, imports map[string]bool) (Exercise, Summary, error) {
	ex := Exercise{ID: id, Readme: files["README.md"]}
	sum := Summary{
		ID:         id,
		Number:     strings.TrimLeft(exerciseDir.FindStringSubmatch(id)[1], "0"),
		ImportPath: module + "/" + id,
	}
	if sum.Number == "" || !unicode.IsDigit(rune(sum.Number[0])) {
		sum.Number = "0" + sum.Number
	}
	if _, ok := files["main.go"]; !ok {
		return ex, sum, errors.New("no main.go")
	}

	var names []string
	for name := range files {
		if strings.HasSuffix(name, ".go") {
			names = append(names, name)
		}
	}
	// main.go first (the only file to edit), then the rest of the package,
	// then the tests - the order a learner reads them in.
	sort.Slice(names, func(i, j int) bool { return fileRank(names[i]) < fileRank(names[j]) })

	fset := token.NewFileSet()
	var tests testFuncs
	var reasons []string
	for _, name := range names {
		src := files[name]
		f, err := parser.ParseFile(fset, name, src, parser.ImportsOnly|parser.ParseComments)
		if err != nil {
			return ex, sum, err
		}
		if f.Name.Name != "main" {
			return ex, sum, fmt.Errorf("%s: package %s; only package main is supported", name, f.Name.Name)
		}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			imports[p] = true
			if why, ok := unsupportedImports[p]; ok {
				reasons = append(reasons, fmt.Sprintf("%s imports %s, which %s", name, p, why))
			}
		}

		isTest := strings.HasSuffix(name, "_test.go")
		ex.Files = append(ex.Files, File{Name: name, Content: src, Editable: name == "main.go", Test: isTest})
		if isTest {
			if err := tests.collect(fset, name, src); err != nil {
				return ex, sum, err
			}
		}
	}
	if len(reasons) > 0 {
		slices.Sort(reasons)
		sum.Unsupported = strings.Join(slices.Compact(reasons), "; ")
	}

	if len(tests.Tests)+len(tests.Benchmarks)+len(tests.FuzzTargets) > 0 || tests.TestMain {
		tests.ImportPath = sum.ImportPath
		var buf bytes.Buffer
		if err := testMainTmpl.Execute(&buf, tests); err != nil {
			return ex, sum, err
		}
		out, err := format.Source(buf.Bytes())
		if err != nil {
			return ex, sum, fmt.Errorf("generated _testmain.go: %w", err)
		}
		ex.TestMain = string(out)
		ex.Tests = tests.Tests
	}
	return ex, sum, nil
}

func fileRank(name string) string {
	switch {
	case name == "main.go":
		return "0"
	case strings.HasSuffix(name, "_test.go"):
		return "2" + name
	default:
		return "1" + name
	}
}

// testFuncs mirrors what cmd/go collects to generate a test binary's main.
type testFuncs struct {
	ImportPath  string
	Tests       []string
	Benchmarks  []string
	FuzzTargets []string
	TestMain    bool
}

func (t *testFuncs) collect(fset *token.FileSet, name, src string) error {
	f, err := parser.ParseFile(fset, name, src, 0)
	if err != nil {
		return err
	}
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		n := fn.Name.Name
		switch {
		case n == "TestMain" && takes(fn, "M"):
			t.TestMain = true
		case isTest(n, "Test") && takes(fn, "T"):
			t.Tests = append(t.Tests, n)
		case isTest(n, "Benchmark") && takes(fn, "B"):
			t.Benchmarks = append(t.Benchmarks, n)
		case isTest(n, "Fuzz") && takes(fn, "F"):
			t.FuzzTargets = append(t.FuzzTargets, n)
		case isTest(n, "Example"):
			// Examples need go/doc's output comparison; no exercise uses
			// one yet, so fail loudly instead of silently skipping it.
			return fmt.Errorf("%s: %s: Example functions are not supported by the in-browser runner", name, n)
		}
	}
	return nil
}

// isTest reports whether name looks like a test function with the given
// prefix, using the same rule as cmd/go: TestFoo yes, Testfoo no.
func isTest(name, prefix string) bool {
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	if len(name) == len(prefix) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(name[len(prefix):])
	return !unicode.IsLower(r)
}

// takes reports whether fn's only parameter is *testing.<typ>.
func takes(fn *ast.FuncDecl, typ string) bool {
	params := fn.Type.Params.List
	if len(params) != 1 || len(params[0].Names) > 1 {
		return false
	}
	star, ok := params[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "testing" && sel.Sel.Name == typ
}

// testMainTmpl follows the template in cmd/go/internal/load/test.go.
var testMainTmpl = template.Must(template.New("main").Parse(`// Code generated by 'go test'. DO NOT EDIT.

package main

import (
	"os"
{{if .TestMain}}	"reflect"
{{end}}	"testing"
	"testing/internal/testdeps"

	_test {{printf "%q" .ImportPath}}
)

var tests = []testing.InternalTest{
{{range .Tests}}	{ {{printf "%q" .}}, _test.{{.}} },
{{end}}}

var benchmarks = []testing.InternalBenchmark{
{{range .Benchmarks}}	{ {{printf "%q" .}}, _test.{{.}} },
{{end}}}

var fuzzTargets = []testing.InternalFuzzTarget{
{{range .FuzzTargets}}	{ {{printf "%q" .}}, _test.{{.}} },
{{end}}}

var examples = []testing.InternalExample{}

func init() {
	testdeps.ImportPath = {{printf "%q" .ImportPath}}
}

func main() {
	m := testing.MainStart(testdeps.TestDeps{}, tests, benchmarks, fuzzTargets, examples)
{{if .TestMain}}	_test.TestMain(m)
	os.Exit(int(reflect.ValueOf(m).Elem().FieldByName("exitCode").Int()))
{{else}}	os.Exit(m.Run())
{{end}}}
`))

type overviewMeta struct {
	order      int
	title      string
	difficulty string
	topics     []string
}

// parseOverview reads title, difficulty and topics from the root README's
// overview table, so the site never disagrees with the README.
func parseOverview(readme string) map[string]overviewMeta {
	meta := map[string]overviewMeta{}
	for _, line := range strings.Split(readme, "\n") {
		m := tableRow.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		var topics []string
		for _, t := range topicCode.FindAllStringSubmatch(m[4], -1) {
			topics = append(topics, t[1])
		}
		meta[m[2]] = overviewMeta{order: len(meta), title: m[1], difficulty: m[3], topics: topics}
	}
	return meta
}

// orderKey keeps the README's table order; exercises missing from the
// table sort after it, by folder name.
func orderKey(id string, meta map[string]overviewMeta) string {
	if m, ok := meta[id]; ok {
		return fmt.Sprintf("0%04d", m.order)
	}
	return "1" + id
}

func firstHeading(md, fallback string) string {
	for _, line := range strings.Split(md, "\n") {
		if t, ok := strings.CutPrefix(line, "# "); ok {
			return strings.TrimSpace(t)
		}
	}
	return fallback
}

func submatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

func git(repo string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// readHEAD returns every committed text file we care about, keyed by its
// repository path.
func readHEAD(repo string) (map[string]string, error) {
	cmd := exec.Command("git", "-C", repo, "archive", "--format=tar", "HEAD")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	files := map[string]string{}
	tr := tar.NewReader(stdout)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		ext := path.Ext(hdr.Name)
		if ext != ".go" && ext != ".md" && hdr.Name != "go.mod" {
			continue
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		files[hdr.Name] = string(b)
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("git archive HEAD: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return files, nil
}

// writeData writes v as public/data/<name>.<hash>.json and returns its URL
// path. The content hash in the name lets the host cache it forever.
func writeData(dir, name string, v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	file := fmt.Sprintf("%s.%s.json", name, hex.EncodeToString(sum[:])[:10])
	if err := os.WriteFile(filepath.Join(dir, file), b, 0o644); err != nil {
		return "", err
	}
	return "/data/" + file, nil
}

func writeJSON(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return err
	}
	return os.WriteFile(name, append(b, '\n'), 0o644)
}
