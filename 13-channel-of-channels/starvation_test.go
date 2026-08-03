package main

import (
	"testing"
	"time"
)

// TestBridgeDoesNotStarveOnSlowShard lives alongside check_test.go rather
// than inside it (check_test.go is marked "DO NOT EDIT" for solvers) but
// is required to pass just the same - see README.md.
//
// Shard 0 arrives on chanStream but never sends a line and never closes
// ("stuck" - imagine a shard whose producer is wedged, or a connection
// that's still open but idle). Shard 1 arrives right after and already
// has a line ready to send. A Bridge that truly fans shards in
// concurrently (one goroutine per shard) still delivers shard 1's line
// promptly, regardless of shard 0's state. A Bridge that drains
// chanStream's shards strictly one at a time - fully finishing shard 0
// before going back to chanStream for shard 1 - never even reads shard 1
// off chanStream, so this test times out against it.
func TestBridgeDoesNotStarveOnSlowShard(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	chanStream := make(chan (<-chan string))

	stuck := make(chan string) // never sent to, never closed
	ready := make(chan string, 1)
	ready <- "shard-1-line-0"

	go func() {
		chanStream <- stuck
		chanStream <- ready
	}()

	logs := Bridge(chanStream, done)

	select {
	case line := <-logs:
		if line != "shard-1-line-0" {
			t.Fatalf("got %q, want shard-1-line-0", line)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Bridge starved: a stuck shard blocked lines from a later, ready shard")
	}
}
