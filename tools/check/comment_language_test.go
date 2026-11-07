package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestCommentLanguageProblems(t *testing.T) {
	long := strings.TrimSpace(strings.Repeat("word ", commentSentenceLimit+1))
	source := fmt.Sprintf(`//go:build linux

package main

// https://example.com/a/very/long/path/that/does/not/count/as/prose
//go:generate %s
// This sentence is allowed.
//
//	func F() {
//		this indented code example is deliberately longer than the prose limit
//	}
//
//	| this | table row is also much longer than the prose sentence limit |
//
// %s.
//
// We demonstrate the result.

/*
Example:
`+"```go"+`
This fenced example has many words and is deliberately longer than the prose limit.
`+"```"+`
*/

// DO NOT EDIT THIS PART
// %s
func F() {}
`, long, long, long)

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "exercise/main.go", source, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	got := commentLanguageProblems("exercise/main.go", fset, file, "exercise")
	if len(got) != 2 {
		t.Fatalf("got %d problems, want 2:\n%v", len(got), got)
	}
	if !strings.Contains(got[0].msg, fmt.Sprintf("%d words", commentSentenceLimit+1)) {
		t.Errorf("long-sentence message = %q", got[0].msg)
	}
	if !strings.Contains(got[1].msg, "hard word: demonstrate") {
		t.Errorf("hard-word message = %q", got[1].msg)
	}
}

func TestCommentSentenceLimit(t *testing.T) {
	atLimit := strings.TrimSpace(strings.Repeat("word ", commentSentenceLimit))
	overLimit := strings.TrimSpace(strings.Repeat("word ", commentSentenceLimit+1))
	for _, c := range []struct {
		name string
		text string
		want int
	}{
		{"at limit", atLimit, commentSentenceLimit},
		{"one over", overLimit, commentSentenceLimit + 1},
	} {
		got := len(strings.Fields(splitCommentSentences(c.text)[0]))
		if got != c.want {
			t.Errorf("%s: counted %d words, want %d", c.name, got, c.want)
		}
	}
}

func TestCleanCommentURLsPreservesSentencePunctuation(t *testing.T) {
	got := strings.Join(strings.Fields(cleanCommentURLs("See https://example.com. Next.")), " ")
	if want := "See . Next."; got != want {
		t.Errorf("cleanCommentURLs = %q, want %q", got, want)
	}
	if hard := commentHardWord.FindAllString(cleanCommentURLs("https://example.com/demonstrate"), -1); len(hard) != 0 {
		t.Errorf("fixture unexpectedly contains a hard word: %v", hard)
	}
}

func TestCommentHardWordsMatchWebAudit(t *testing.T) {
	source, err := os.ReadFile("../../web/scripts/language-audit.ts")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?s)const hardWords\s*=\s*/\\b\(([^)]+)\)\\b/gi;`).FindSubmatch(source)
	if match == nil {
		t.Fatal("could not find hardWords in web/scripts/language-audit.ts")
	}
	webWords := strings.Split(string(match[1]), "|")
	goWords := slices.Clone(commentHardWords)
	slices.Sort(webWords)
	slices.Sort(goWords)
	if !slices.Equal(webWords, goWords) {
		t.Fatalf("hard-word lists differ:\nweb: %v\ngo:  %v", webWords, goWords)
	}
}
