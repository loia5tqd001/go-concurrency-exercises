package main

import "testing"

// The first body is the fixture in web/scripts/viz-kit.test.ts. Both hashers
// must produce the same pin, or the Go lint and the TypeScript site disagree
// about which README fence a spec pins.
func TestDiagramHash(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"fixture shared with the TypeScript test", "+-------+\n|  ch   |\n+-------+", "fnv1a:43d3b52c"},
		{"empty body is the offset basis", "", "fnv1a:811c9dc5"},
		{"whitespace-only body normalizes to empty", "  \n\n", "fnv1a:811c9dc5"},
		{"arrow hashes its UTF-8 bytes", "→", "fnv1a:9f874291"},
	}
	for _, c := range cases {
		if got := diagramHash(c.body); got != c.want {
			t.Errorf("%s: diagramHash(%q) = %s, want %s", c.name, c.body, got, c.want)
		}
	}
}

func TestNormalizeDiagram(t *testing.T) {
	raw := "+-------+\r\n|  ch   |   \n+-------+\n\n"
	want := "+-------+\n|  ch   |\n+-------+"
	if got := normalizeDiagram(raw); got != want {
		t.Errorf("normalizeDiagram(%q) = %q, want %q", raw, got, want)
	}
}

func TestPlainFencesIgnoreAnnotatedBlocks(t *testing.T) {
	md := "```\n+---+\n```\n\n```go\n+---+\n```\n\n```text\n| x |\n```\n"
	got := plainFences(md)
	if len(got) != 2 {
		t.Fatalf("plainFences found %d fences, want 2", len(got))
	}
	if got[0].body != "+---+" || got[1].body != "| x |" {
		t.Errorf("plainFences bodies = %q, %q", got[0].body, got[1].body)
	}
}

func TestSpecDiagramPins(t *testing.T) {
	oneLine := `defineViz({ diagrams: { today: "fnv1a:aaaaaaaa", goal: "fnv1a:bbbbbbbb" } })`
	multiLine := "defineViz({\n  diagrams: {\n    today: \"fnv1a:cccccccc\",\n  },\n})"
	for _, c := range []struct {
		name string
		src  string
		want map[string]string
	}{
		{"one line", oneLine, map[string]string{"today": "fnv1a:aaaaaaaa", "goal": "fnv1a:bbbbbbbb"}},
		{"several lines", multiLine, map[string]string{"today": "fnv1a:cccccccc"}},
		{"no block", "defineViz({})", map[string]string{}},
	} {
		got := specDiagramPins(c.src)
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
			continue
		}
		for k, v := range c.want {
			if got[k] != v {
				t.Errorf("%s: pins[%q] = %q, want %q", c.name, k, got[k], v)
			}
		}
	}
}
