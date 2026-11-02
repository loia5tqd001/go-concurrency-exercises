package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A generated section sits between a BEGIN and an END marker line. Its body
// is derived from the overview table, so a hand edit inside it is lost and
// `check lint` reports the section as stale until `check gen` runs.
type section struct {
	file   string
	name   string
	render func(rows []row) string
}

var sections = []section{
	{"README.md", "topic-index", renderTopicIndex},
	{"solutions/README.md", "solutions-index", renderSolutionsIndex},
}

func beginMarker(name string) string {
	return "<!-- BEGIN GENERATED " + name + ": edit the overview table in README.md, then run `make gen` -->"
}

func endMarker(name string) string { return "<!-- END GENERATED " + name + " -->" }

// fill returns content with the named section's body replaced.
func fill(content, name, body string) (string, error) {
	lines := strings.Split(content, "\n")
	begin, end := -1, -1
	for i, l := range lines {
		switch {
		case strings.HasPrefix(l, "<!-- BEGIN GENERATED "+name+":"):
			begin = i
		case l == endMarker(name):
			end = i
		}
	}
	if begin < 0 || end < begin {
		return "", fmt.Errorf("markers for generated section %q are missing or out of order", name)
	}
	out := append([]string{}, lines[:begin]...)
	out = append(out, beginMarker(name))
	out = append(out, strings.Split(strings.TrimSuffix(body, "\n"), "\n")...)
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n"), nil
}

func renderTopicIndex(rows []row) string {
	links := map[string][]string{}
	for _, r := range rows {
		m := exerciseDir.FindStringSubmatch(r.dir)
		if m == nil {
			continue
		}
		for _, t := range r.topics {
			links[t] = append(links[t], fmt.Sprintf("[%s](./%s)", m[1]+m[2], r.dir))
		}
	}
	topics := make([]string, 0, len(links))
	width := len("Topic")
	for t := range links {
		topics = append(topics, t)
		width = max(width, len(t)+2)
	}
	sort.Strings(topics)
	var b strings.Builder
	fmt.Fprintf(&b, "| %-*s | Exercises |\n", width, "Topic")
	fmt.Fprintf(&b, "| %s | --------- |\n", strings.Repeat("-", width))
	for _, t := range topics {
		fmt.Fprintf(&b, "| %-*s | %s |\n", width, "`"+t+"`", strings.Join(links[t], ", "))
	}
	return b.String()
}

func renderSolutionsIndex(rows []row) string {
	var b strings.Builder
	b.WriteString("| # | Exercise | Solution |\n|---|----------|----------|\n")
	for _, r := range rows {
		fmt.Fprintf(&b, "| %s | %s | [%s.md](%s.md) |\n", r.num, r.title, r.dir, r.dir)
	}
	return b.String()
}

// expected returns what each section file should contain, keyed by file.
func expected(t *tree) (map[string]string, error) {
	readme, err := t.read("README.md")
	if err != nil {
		return nil, err
	}
	rows := overviewRows(string(readme))
	want := map[string]string{}
	for _, s := range sections {
		cur, ok := want[s.file]
		if !ok {
			b, err := t.read(s.file)
			if err != nil {
				return nil, err
			}
			cur = string(b)
		}
		next, err := fill(cur, s.name, s.render(rows))
		if err != nil {
			return nil, fmt.Errorf("%s: %v", s.file, err)
		}
		want[s.file] = next
	}
	return want, nil
}

func runGen(args []string) error {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	fs.Parse(args)
	root, err := repoRoot()
	if err != nil {
		return err
	}
	t := &tree{src: "worktree", root: root}
	want, err := expected(t)
	if err != nil {
		return err
	}
	for _, file := range []string{"README.md", "solutions/README.md"} {
		cur, err := t.read(file)
		if err != nil {
			return err
		}
		if string(cur) == want[file] {
			continue
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(want[file]), 0o644); err != nil {
			return err
		}
		fmt.Println("updated", file)
	}
	return nil
}
