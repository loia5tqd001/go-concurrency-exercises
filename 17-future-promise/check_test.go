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

// uniqueTestKey isolates keys when tests run repeatedly.
func uniqueTestKey(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, testKeySeq.Add(1))
}

// expectedResult computes the expected value without the delay.
func expectedResult(key string) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))

	return int(h.Sum64() % 1_000_000)
}

// TestFutureReturnsImmediately checks Future does not wait for ComputeExpensive.
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

// TestFutureReturnsCorrectResult checks the delivered value matches the key.
func TestFutureReturnsCorrectResult(t *testing.T) {
	ResetCallCount()
	key := uniqueTestKey("k2")

	got := <-Future(key)

	if want := expectedResult(key); got != want {
		t.Errorf("Future(%q) delivered %d, want %d", key, got, want)
	}
}

// TestFutureDedupesConcurrentCallers calls Future for one key many times.
// All callers must share one computation and result.
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

// TestFutureCachesAfterCompletion calls one key twice.
// The second call must reuse the cached result.
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
