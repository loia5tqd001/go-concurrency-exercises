//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"hash/fnv"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

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

		start := time.Now()
		ch := Future("k1")
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

	got := <-Future("k2")

	if want := expectedResult("k2"); got != want {
		t.Errorf(`Future("k2") delivered %d, want %d`, got, want)
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

	results := make([]int, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()
			results[i] = <-Future("k3")
		}()
	}
	wg.Wait()

	want := expectedResult("k3")
	for i, got := range results {
		if got != want {
			t.Errorf("results[%d] = %d, want %d (all callers must observe the same result)", i, got, want)
		}
	}

	if cc := CallCount(); cc != 1 {
		t.Errorf("ComputeExpensive ran %d times across %d concurrent Future(\"k3\") callers, want exactly 1", cc, callers)
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

		<-Future("k4")

		start := time.Now()
		got := <-Future("k4")
		elapsed := time.Since(start)

		if elapsed >= 10*time.Millisecond {
			t.Errorf(`second Future("k4") call took %s, want near-instant since the result should already be cached`, elapsed)
		}

		if want := expectedResult("k4"); got != want {
			t.Errorf(`second Future("k4") call delivered %d, want %d`, got, want)
		}

		if cc := CallCount(); cc != 1 {
			t.Errorf("ComputeExpensive ran %d times across two sequential Future(\"k4\") calls, want exactly 1", cc)
		}
	})
}
