//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"hash/fnv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

var testKeySeq atomic.Uint64

// uniqueTestKey keeps -count=N runs isolated even though a correct Future
// caches values for the life of the test binary.
func uniqueTestKey(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, testKeySeq.Add(1))
}

// expectedResult mirrors the (deterministic) result-generation logic
// in ComputeExpensive, without paying for the simulated latency, so
// tests can check correctness cheaply.
func expectedResult(key string) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))

	return int(h.Sum64() % 1_000_000)
}

// TestFutureReturnsImmediately asserts that Future kicks off the
// computation in the background and returns a channel near-instantly,
// instead of blocking the caller for the full ComputeLatency. It
// fails against the naive implementation, which calls ComputeExpensive
// synchronously before returning.
func TestFutureReturnsImmediately(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ResetCallCount()
		key := uniqueTestKey("k1")

		start := time.Now()
		ch := Future(key)
		elapsed := time.Since(start)

		if elapsed >= 10*time.Millisecond {
			t.Errorf("Future took %s (ComputeExpensive takes %s); "+
				"want near-instant return - looks like Future is "+
				"computing the result synchronously instead of in the background",
				elapsed, ComputeLatency)
		}

		<-ch
	})
}

// TestFutureReturnsCorrectResult checks that the channel Future
// returns delivers the same deterministic value ComputeExpensive
// would directly produce for the same key.
func TestFutureReturnsCorrectResult(t *testing.T) {
	ResetCallCount()
	key := uniqueTestKey("k2")

	got := <-Future(key)

	if want := expectedResult(key); got != want {
		t.Errorf("Future(%q) delivered %d, want %d", key, got, want)
	}
}

// TestFutureDedupesConcurrentCallers calls Future for the SAME key
// from many goroutines at once, while the first call's computation is
// still in flight, and asserts that they all observe the same result
// AND that the underlying expensive computation ran exactly once.
// This guards against a "fixed" implementation that makes Future
// async but recomputes independently on every call instead of sharing
// one in-flight computation per key. Run with `go test -race`.
func TestFutureDedupesConcurrentCallers(t *testing.T) {
	ResetCallCount()

	const callers = 20
	key := uniqueTestKey("k3")

	results := make([]int, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()
			results[i] = <-Future(key)
		}()
	}
	wg.Wait()

	want := expectedResult(key)
	for i, got := range results {
		if got != want {
			t.Errorf("results[%d] = %d, want %d (all callers must observe the same result)", i, got, want)
		}
	}

	if cc := CallCount(); cc != 1 {
		t.Errorf("ComputeExpensive ran %d times across %d concurrent Future(%q) callers, want exactly 1", cc, callers, key)
	}
}

// TestFutureCachesAfterCompletion calls Future for a key, waits for
// its result, then calls Future again for the SAME key and asserts
// the second call also returns near-instantly with the same cached
// result, without triggering a second call to ComputeExpensive. This
// guards against an implementation that only dedupes calls that
// happen to overlap in time, forgetting the result once nobody is
// waiting on it anymore.
func TestFutureCachesAfterCompletion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ResetCallCount()
		key := uniqueTestKey("k4")

		<-Future(key)

		start := time.Now()
		got := <-Future(key)
		elapsed := time.Since(start)

		if elapsed >= 10*time.Millisecond {
			t.Errorf("second Future(%q) call took %s, want near-instant since the result should already be cached", key, elapsed)
		}

		if want := expectedResult(key); got != want {
			t.Errorf("second Future(%q) call delivered %d, want %d", key, got, want)
		}

		if cc := CallCount(); cc != 1 {
			t.Errorf("ComputeExpensive ran %d times across two sequential Future(%q) calls, want exactly 1", cc, key)
		}
	})
}
