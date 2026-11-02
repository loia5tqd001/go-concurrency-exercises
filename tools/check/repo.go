package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The root README's overview table is the single source of truth for each
// exercise's number, title, difficulty, and topics. The web site (web/tools/gen)
// parses the same rows, and `check gen` derives the topic index and the
// solutions index from it.

var (
	exerciseDir = regexp.MustCompile(`^(\d{2})([a-z]?)-[a-z0-9]+(-[a-z0-9]+)*$`)
	// | 14b | [Title](./14b-folder) | ![hard](https://img.shields.io/badge/-hard-orange) | `topic` `topic` |
	overviewRow = regexp.MustCompile(`^\|\s*(\d+[a-z]?)\s*\|\s*\[(.+?)\]\(\./([^)/]+)/?\)\s*\|\s*!\[([^\]]*)\]\(([^)]*)\)\s*\|(.*)\|\s*$`)
	topicCode   = regexp.MustCompile("`([^`]+)`")
	topicName   = regexp.MustCompile(`^[a-z0-9][a-z0-9./-]*$`)
)

// tiers lists the difficulty badges from easiest to hardest. A lettered
// sequel may never sit on an earlier tier than its parent.
var tiers = []struct{ name, badge string }{
	{"warm-up", "https://img.shields.io/badge/-warm--up-lightgrey"},
	{"easy", "https://img.shields.io/badge/-easy-brightgreen"},
	{"medium", "https://img.shields.io/badge/-medium-blue"},
	{"hard", "https://img.shields.io/badge/-hard-orange"},
	{"extreme", "https://img.shields.io/badge/-extreme-red"},
}

func tierIndex(name string) int {
	for i, t := range tiers {
		if t.name == name {
			return i
		}
	}
	return -1
}

type exercise struct {
	id     string // folder name, e.g. "14b-tee-channel-independent-close"
	prefix string // folder prefix used in link text, e.g. "05", "14b"
	num    string // number as the overview table writes it, e.g. "5", "14b"
	parent string // number of the exercise a lettered sequel extends, e.g. "14"; "" otherwise
}

// exercises returns every exercise folder in t, in folder order. Folder
// order puts a lettered sequel right after its parent ("14-" < "14b-").
func exercises(t *tree) []exercise {
	seen := map[string]bool{}
	var out []exercise
	for _, f := range t.files {
		dir, _, ok := strings.Cut(f, "/")
		if !ok || seen[dir] {
			continue
		}
		seen[dir] = true
		m := exerciseDir.FindStringSubmatch(dir)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		ex := exercise{id: dir, prefix: m[1] + m[2], num: strconv.Itoa(n) + m[2]}
		if m[2] != "" {
			ex.parent = strconv.Itoa(n)
		}
		out = append(out, ex)
	}
	return out
}

type row struct {
	line       int // 1-based line in README.md
	num        string
	title      string
	dir        string
	difficulty string
	badge      string
	topics     []string
}

func overviewRows(readme string) []row {
	var rows []row
	for i, line := range strings.Split(readme, "\n") {
		m := overviewRow.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		r := row{line: i + 1, num: m[1], title: strings.TrimSpace(m[2]), dir: m[3], difficulty: m[4], badge: m[5]}
		for _, t := range topicCode.FindAllStringSubmatch(m[6], -1) {
			r.topics = append(r.topics, t[1])
		}
		rows = append(rows, r)
	}
	return rows
}

func (r row) String() string { return fmt.Sprintf("README.md:%d", r.line) }
