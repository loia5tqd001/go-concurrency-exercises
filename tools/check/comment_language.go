package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"regexp"
	"strings"
	"unicode"
)

const commentSentenceLimit = 20

// Keep this list in sync with hardWords in web/scripts/language-audit.ts.
// TestCommentHardWordsMatchWebAudit enforces that contract.
var commentHardWords = []string{
	"arbitrary",
	"adversarial",
	"cognitive",
	"concomitant",
	"consequently",
	"constitute",
	"demonstrate",
	"facilitate",
	"heuristic",
	"invariant",
	"nonetheless",
	"quiescent",
	"structurally",
	"subsequently",
	"utilize",
	"whereas",
}

var (
	commentHardWord = regexp.MustCompile(`(?i)\b(?:` + strings.Join(commentHardWords, "|") + `)\b`)
	commentURL      = regexp.MustCompile(`(?i)(?:https?://|www\.)[^\s<>"']+`)
	commentSentence = regexp.MustCompile(`[.!?](?:\s+|$)`)
)

type commentLine struct {
	line int
	text string
}

// commentLanguageProblems checks prose in Go comments. It ignores build
// directives, URLs, fenced examples, and the test file's required header.
func commentLanguageProblems(file string, fset *token.FileSet, parsed *ast.File, subject string) []problem {
	var problems []problem
	for _, group := range parsed.Comments {
		if strings.Contains(group.Text(), "DO NOT EDIT THIS PART") {
			continue
		}
		for _, paragraph := range commentParagraphs(group, fset) {
			for _, sentence := range splitCommentSentences(paragraph.text) {
				words := strings.Fields(sentence)
				hard := commentHardWord.FindAllString(sentence, -1)
				if len(words) <= commentSentenceLimit && len(hard) == 0 {
					continue
				}
				var reasons []string
				if len(words) > commentSentenceLimit {
					reasons = append(reasons, fmt.Sprintf("%d words", len(words)))
				}
				if len(hard) > 0 {
					reasons = append(reasons, "hard word: "+strings.Join(uniqFold(hard), ", "))
				}
				problems = append(problems, problem{
					rule: "comment-language",
					at:   fmt.Sprintf("%s:%d", file, paragraph.line),
					key:  "comment-language " + subject,
					msg: fmt.Sprintf(
						"comment sentence has %s; keep prose at or below %d words and use plain English",
						strings.Join(reasons, "; "),
						commentSentenceLimit,
					),
				})
			}
		}
	}
	return problems
}

type commentParagraph struct {
	line int
	text string
}

func commentParagraphs(group *ast.CommentGroup, fset *token.FileSet) []commentParagraph {
	var (
		paragraphs []commentParagraph
		lines      []commentLine
		fenced     bool
	)
	flush := func() {
		if len(lines) == 0 {
			return
		}
		parts := make([]string, 0, len(lines))
		for _, line := range lines {
			parts = append(parts, cleanCommentURLs(line.text))
		}
		text := strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
		if strings.IndexFunc(text, unicode.IsLetter) >= 0 {
			paragraphs = append(paragraphs, commentParagraph{line: lines[0].line, text: text})
		}
		lines = nil
	}

	for _, comment := range group.List {
		raw := comment.Text
		body := ""
		switch {
		case strings.HasPrefix(raw, "//"):
			body = strings.TrimPrefix(raw, "//")
			if isCommentDirective(body) {
				flush()
				continue
			}
		case strings.HasPrefix(raw, "/*"):
			body = strings.TrimSuffix(strings.TrimPrefix(raw, "/*"), "*/")
		}
		for i, text := range strings.Split(body, "\n") {
			line := fset.Position(comment.Pos()).Line + i
			indented := strings.HasPrefix(text, "\t") || strings.HasPrefix(text, "    ")
			text = strings.TrimSpace(text)
			if strings.HasPrefix(text, "*") {
				text = strings.TrimSpace(strings.TrimPrefix(text, "*"))
			}
			if indented || strings.HasPrefix(text, "|") {
				flush()
				continue
			}
			if strings.HasPrefix(text, "```") || strings.HasPrefix(text, "~~~") {
				flush()
				fenced = !fenced
				continue
			}
			if fenced {
				continue
			}
			if text == "" || strings.Trim(text, "/-=_* \t") == "" {
				flush()
				continue
			}
			lines = append(lines, commentLine{line: line, text: text})
		}
	}
	flush()
	return paragraphs
}

func isCommentDirective(body string) bool {
	if body == "" || body[0] == ' ' || body[0] == '\t' {
		return false
	}
	head := strings.Fields(body)[0]
	return strings.HasPrefix(head, "go:") ||
		strings.HasPrefix(head, "line:") ||
		strings.HasPrefix(head, "nolint") ||
		strings.HasPrefix(head, "lint:") ||
		head == "line" ||
		head == "extern" ||
		head == "export"
}

func cleanCommentURLs(text string) string {
	return commentURL.ReplaceAllStringFunc(text, func(url string) string {
		start := len(url)
		for start > 0 && strings.ContainsRune(".,;:!?)]}", rune(url[start-1])) {
			start--
		}
		return url[start:]
	})
}

func splitCommentSentences(text string) []string {
	var sentences []string
	start := 0
	for _, match := range commentSentence.FindAllStringIndex(text, -1) {
		end := match[1]
		if sentence := strings.TrimSpace(text[start:end]); sentence != "" {
			sentences = append(sentences, sentence)
		}
		start = end
	}
	if rest := strings.TrimSpace(text[start:]); rest != "" {
		sentences = append(sentences, rest)
	}
	return sentences
}

func uniqFold(words []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, word := range words {
		word = strings.ToLower(word)
		if !seen[word] {
			seen[word] = true
			out = append(out, word)
		}
	}
	return out
}
