package main

import (
	"fmt"
	"hash/fnv"
	"regexp"
	"strings"
)

// diagramHash is the Go twin of web/src/viz/engine/diagramHash.ts. The site
// stamps every plain README fence with this value, the spec pins it, and the
// lint rule compares them without Node. A change to the normalization or to
// the FNV-1a parameters must land on both sides, or every pin goes stale.
//
// Normalization: split on newlines, strip every carriage return and every
// trailing space or tab from each line, drop the empty lines at the top and
// bottom, join with "\n". Output: "fnv1a:" plus 8 lowercase hex digits.
func diagramHash(body string) string {
	h := fnv.New32a() // FNV-1a 32-bit: offset 0x811c9dc5, prime 0x01000193
	h.Write([]byte(normalizeDiagram(body)))
	return fmt.Sprintf("fnv1a:%08x", h.Sum32())
}

func normalizeDiagram(body string) string {
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(strings.ReplaceAll(line, "\r", ""), " \t")
	}
	start, end := 0, len(lines)
	for start < end && lines[start] == "" {
		start++
	}
	for end > start && lines[end-1] == "" {
		end--
	}
	return strings.Join(lines[start:end], "\n")
}

type fence struct {
	info string // opening-line info string, e.g. "go" or ""
	body string // text between the opening and closing lines
	hash string // diagramHash(body)
}

// fences splits a Markdown document into fenced blocks the same way
// web/scripts/viz-check.ts does: a fence opens on a line starting with ```
// and closes on the next such line. An unclosed fence contributes nothing.
func fences(md string) []fence {
	var out []fence
	in, info := false, ""
	var body []string
	for _, line := range strings.Split(md, "\n") {
		if !strings.HasPrefix(line, "```") {
			if in {
				body = append(body, line)
			}
			continue
		}
		if in {
			text := strings.Join(body, "\n")
			out = append(out, fence{info: info, body: text, hash: diagramHash(text)})
			in, body = false, nil
			continue
		}
		in, info, body = true, strings.TrimSpace(line[3:]), nil
	}
	return out
}

// plainFences keeps the fences that carry a diagram pin. A fence annotated
// ```go or ```sh is a code sample, not the hand-drawn shape.
func plainFences(md string) []fence {
	var out []fence
	for _, f := range fences(md) {
		if f.info == "" || f.info == "text" {
			out = append(out, f)
		}
	}
	return out
}

var (
	specDiagramsBlock = regexp.MustCompile(`(?s)\bdiagrams\s*:\s*\{([^}]*)\}`)
	specDiagramPin    = regexp.MustCompile(`\b(today|goal)\s*:\s*"([^"]*)"`)
	diagramPinForm    = regexp.MustCompile(`^fnv1a:[0-9a-f]{8}$`)
)

// specDiagramPins reads the tier -> pin pairs from a spec's diagrams block.
// Tiers other than today and goal are ignored; Phase 2 checks those two.
func specDiagramPins(src string) map[string]string {
	pins := map[string]string{}
	block := specDiagramsBlock.FindStringSubmatch(src)
	if block == nil {
		return pins
	}
	for _, m := range specDiagramPin.FindAllStringSubmatch(block[1], -1) {
		pins[m[1]] = m[2]
	}
	return pins
}
