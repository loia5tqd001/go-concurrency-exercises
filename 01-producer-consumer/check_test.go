//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMainProducesCorrectOutput runs main.
// It checks every tweet is classified in stream order.
func TestMainProducesCorrectOutput(t *testing.T) {
	output := captureStdout(t, main, 10*time.Second)

	want := [][2]string{
		{"davecheney", "tweets about golang"},
		{"beertocode", "does not tweet about golang"},
		{"ironzeb", "tweets about golang"},
		{"beertocode", "tweets about golang"},
		{"vampirewalk666", "tweets about golang"},
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) < len(want) {
		t.Fatalf("expected at least %d lines of output, got %d:\n%s", len(want), len(lines), output)
	}
	for i, w := range want {
		if !strings.Contains(lines[i], w[0]) || !strings.Contains(lines[i], w[1]) {
			t.Errorf("line %d = %q, want it to mention %q and %q", i, lines[i], w[0], w[1])
		}
	}
}

// TestMainRunsProducerAndConsumerConcurrently checks the run time.
// Reading and classifying all tweets one after another takes about 3.25s.
// Overlapping the two stages takes about 1.97s.
// The 2.5s limit separates the two designs reliably.
func TestMainRunsProducerAndConsumerConcurrently(t *testing.T) {
	start := time.Now()
	captureStdout(t, main, 10*time.Second)
	elapsed := time.Since(start)

	if elapsed > 2500*time.Millisecond {
		t.Errorf("main() took %s, want well under the ~3.25s a fully sequential producer+consumer would take - producer and consumer must run concurrently", elapsed)
	}
}

// captureStdout runs fn and returns everything it writes.
// A timeout prevents a broken pipeline from hanging the test.
// The test cannot kill a truly stuck goroutine.
// It still fails after the timeout.
// Writes after cleanup are dropped.
// The browser test runner has no pipes.
// Use a temp file so the same test works in the browser.
func captureStdout(t *testing.T, fn func(), timeout time.Duration) string {
	t.Helper()

	orig := os.Stdout
	f, err := os.Create(filepath.Join(t.TempDir(), "stdout"))
	if err != nil {
		t.Fatalf("create stdout capture file: %v", err)
	}
	os.Stdout = f

	doneFn := make(chan struct{})
	go func() {
		fn()
		close(doneFn)
	}()

	select {
	case <-doneFn:
	case <-time.After(timeout):
		os.Stdout = orig
		f.Close()
		t.Fatalf("main() did not return within %s - producer and consumer are likely deadlocked", timeout)
		return ""
	}

	os.Stdout = orig
	f.Close()

	out, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	return string(out)
}
