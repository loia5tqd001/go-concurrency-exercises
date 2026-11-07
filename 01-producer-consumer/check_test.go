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

// TestMainProducesCorrectOutput runs the program's actual main() and
// checks that every tweet is classified correctly and printed in the
// same order the mock stream produces them - regardless of how
// producer/consumer are wired up internally, since main() is the only
// part of the contract this exercise doesn't let you change.
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

// TestMainRunsProducerAndConsumerConcurrently checks that the total
// time is close to the slower of the two stages run back-to-back per
// tweet, rather than close to their sum. Each Stream.Next() sleeps
// 320ms and each IsTalkingAboutGo() sleeps 330ms; running them fully
// sequentially (read all 5, then classify all 5) takes roughly
// 5*(320+330)ms = 3.25s. Pipelining them - the producer reading ahead
// while the consumer is still classifying an earlier tweet - takes
// closer to one read plus five classifications, ~1.97s, since
// classifying tweet N overlaps with reading tweet N+1. 2.5s is well
// above the pipelined time and well below the sequential time, so it
// reliably tells the two apart without being flaky about exactly how
// much the pipeline saves.
func TestMainRunsProducerAndConsumerConcurrently(t *testing.T) {
	start := time.Now()
	captureStdout(t, main, 10*time.Second)
	elapsed := time.Since(start)

	if elapsed > 2500*time.Millisecond {
		t.Errorf("main() took %s, want well under the ~3.25s a fully sequential producer+consumer would take - producer and consumer must run concurrently", elapsed)
	}
}

// captureStdout redirects os.Stdout for the duration of fn and returns
// everything written to it. fn is bounded to timeout: a producer and
// consumer wired together incorrectly (e.g. a send on a channel nobody
// is left to receive from, or a range over a channel that's never
// closed) can deadlock, and calling fn directly with no guard would
// hang the test toward Go's default 10-minute -timeout instead of
// failing fast - go test's own alarm goroutine means the runtime's
// deadlock detector never fires inside a test binary, timeout or not,
// so this guard is the only thing that catches it quickly.
//
// If fn truly deadlocks, its goroutine is left running - there's no
// way to force it to exit - but the test still fails within timeout
// instead of hanging. Its writes (if any ever happen) land on the now
// -closed file and are silently dropped, which is harmless.
//
// Output goes to a temp file rather than an os.Pipe because GOOS=js
// (the in-browser runner) has no pipes; a file behaves the same here,
// since nothing reads the output until fn has returned.
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
