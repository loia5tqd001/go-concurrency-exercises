//////////////////////////////////////////////////////////////////////
//
// Keep the mutex out of ComputeExpensive.
// Otherwise one key blocks every other key.
// This uses a real clock because synctest cannot model a blocked mutex.
//

package main

import (
	"testing"
	"time"
)

// TestFutureRunsDifferentKeysConcurrently checks two keys compute in parallel.
func TestFutureRunsDifferentKeysConcurrently(t *testing.T) {
	ResetCallCount()
	key1 := uniqueTestKey("concurrent-key-1")
	key2 := uniqueTestKey("concurrent-key-2")

	start := time.Now()

	ch1 := Future(key1)
	ch2 := Future(key2)

	<-ch1
	<-ch2

	elapsed := time.Since(start)

	// Parallel work takes about one latency.
	// Serialized work takes about two.
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
