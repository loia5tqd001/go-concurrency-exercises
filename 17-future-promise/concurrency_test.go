//////////////////////////////////////////////////////////////////////
//
// Regression test added by /judge review: the shared main.go held its
// mutex across the call to ComputeExpensive itself, not just around
// the map lookups, which serializes ALL keys behind one global lock -
// a Future("k2") call can't even start computing until an unrelated
// Future("k1") call finishes, even though the two share no state.
//
// This intentionally does NOT use testing/synctest: a goroutine
// blocked on sync.Mutex.Lock is not "durably blocked" in synctest's
// sense (only channel ops, sync.Cond, sync.WaitGroup and time.Sleep
// are), so a buggy implementation that holds a mutex across a
// time.Sleep deadlocks the whole synctest bubble instead of failing
// cleanly. Real time is used instead, same as
// TestFutureDedupesConcurrentCallers in check_test.go.
//
// check_test.go is intentionally left untouched ("DO NOT EDIT THIS
// PART"); this lives in its own file instead.
//

package main

import (
	"testing"
	"time"
)

// TestFutureRunsDifferentKeysConcurrently calls Future for two distinct
// keys back to back and asserts both computations run in parallel
// instead of one waiting for the other to finish. It fails against an
// implementation that holds a single global lock for the full duration
// of ComputeExpensive, since that serializes unrelated keys behind one
// another.
func TestFutureRunsDifferentKeysConcurrently(t *testing.T) {
	ResetCallCount()

	start := time.Now()

	ch1 := Future("concurrent-key-1")
	ch2 := Future("concurrent-key-2")

	<-ch1
	<-ch2

	elapsed := time.Since(start)

	// Two independent computations running in parallel finish around
	// ComputeLatency; serialized behind a shared lock they finish
	// around 2*ComputeLatency. The threshold sits strictly between the
	// two, with generous margin for scheduling jitter.
	if threshold := ComputeLatency + ComputeLatency/2; elapsed >= threshold {
		t.Errorf("Future for two different keys took %s together, want under %s "+
			"(each ComputeExpensive call takes %s; computations for different "+
			"keys must run concurrently, not serialize behind a shared lock)",
			elapsed, threshold, ComputeLatency)
	}

	if cc := CallCount(); cc != 2 {
		t.Errorf("ComputeExpensive ran %d times for 2 distinct keys, want exactly 2", cc)
	}
}
