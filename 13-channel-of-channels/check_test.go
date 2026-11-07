//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"testing"
	"time"
)

// TestBridgeFlattensAllShards requires every line from every shard.
// It uses a real clock because broken producers can remain blocked.
// The timeout turns a non-closing output into a test failure.
func TestBridgeFlattensAllShards(t *testing.T) {
	const numShards = 5
	const linesPerShard = 4

	done := make(chan struct{})
	defer close(done)

	shardStream := StartLogHub(numShards, linesPerShard)
	logs := Bridge(shardStream, done)

	got := make(map[string]int)
	timeout := time.After(2 * time.Second)

collect:
	for {
		select {
		case line, ok := <-logs:
			if !ok {
				break collect
			}
			got[line]++
		case <-timeout:
			t.Fatal("timed out waiting for Bridge to flatten all shards")
		}
	}

	total := 0
	for _, n := range got {
		total += n
	}

	if total != numShards*linesPerShard {
		t.Fatalf("got %d total log lines, want %d (only shards seen: %d unique lines)", total, numShards*linesPerShard, len(got))
	}

	for shardIdx := 0; shardIdx < numShards; shardIdx++ {
		for i := 0; i < linesPerShard; i++ {
			want := fmt.Sprintf("shard-%d-line-%d", shardIdx, i)
			if got[want] != 1 {
				t.Errorf("expected exactly one occurrence of %q, got %d", want, got[want])
			}
		}
	}
}

// TestBridgeStopsOnDone requires output to close after done closes.
// The timeout is generous enough for a busy machine.
func TestBridgeStopsOnDone(t *testing.T) {
	done := make(chan struct{})

	shardStream := StartLogHub(50, 50)
	logs := Bridge(shardStream, done)

	for i := 0; i < 3; i++ {
		select {
		case _, ok := <-logs:
			if !ok {
				t.Fatal("output channel closed before we could read the first few values")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out reading initial values from Bridge output")
		}
	}

	close(done)

	deadline := time.After(200 * time.Millisecond)
	for {
		select {
		case _, ok := <-logs:
			if !ok {
				return // Output closed promptly.
			}
			// Drain values already in flight.
		case <-deadline:
			t.Fatal("Bridge did not close its output channel promptly after done was closed")
		}
	}
}
