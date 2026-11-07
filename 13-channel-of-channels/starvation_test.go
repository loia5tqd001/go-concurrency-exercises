package main

import (
	"testing"
	"time"
)

// TestBridgeDoesNotStarveOnSlowShard requires concurrent shard draining.
// Shard 0 never sends or closes. Shard 1 is ready immediately.
// A one-shard-at-a-time Bridge never reads shard 1 and times out.
func TestBridgeDoesNotStarveOnSlowShard(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	chanStream := make(chan (<-chan string))

	stuck := make(chan string) // Never sent to or closed.
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
