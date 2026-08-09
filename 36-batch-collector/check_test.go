//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// recvTimeout bounds every channel receive in this file. The naive
// Collector can lose increments to its unsynchronized nQueued field,
// so `execute` may never run at all - callers would then block on
// their result channel forever. A bounded receive turns that failure
// into a clear, fast test failure instead of a 10-minute `go test`
// timeout with no useful message.
const recvTimeout = 2 * time.Second

func recvResult(t *testing.T, ch <-chan Result) Result {
	t.Helper()

	select {
	case r := <-ch:
		return r
	case <-time.After(recvTimeout):
		t.Fatalf("timed out after %s waiting for a Result - the batch likely never fired", recvTimeout)
		return Result{}
	}
}

// TestCollectorSingleRequest checks the uncontended case: one Add,
// one request in the batch, fn runs once expected is reached (1) and
// the caller gets its own doubled value back.
func TestCollectorSingleRequest(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	fn := func(requests []int) ([]int, error) {
		mu.Lock()
		callCount++
		mu.Unlock()

		responses := make([]int, len(requests))
		for i, r := range requests {
			responses[i] = r * 2
		}
		return responses, nil
	}

	c := NewCollector(1, fn)
	result := recvResult(t, c.Add(21))

	if result.Err != nil {
		t.Fatalf("Add(21) returned error %v, want nil", result.Err)
	}

	if result.Value != 42 {
		t.Errorf("Add(21) = %d, want 42", result.Value)
	}

	if callCount != 1 {
		t.Errorf("fn ran %d time(s), want exactly 1", callCount)
	}
}

// TestCollectorFiresBatchExactlyOnceAndMapsResultsCorrectly is the
// core test: `callers` goroutines all call Add concurrently, each
// with its own distinct request. It asserts fn ran EXACTLY once
// across all of them (guarding against the double-fire trap a
// careless "lock the append, unlock, then check-and-fire" fix falls
// into), that every caller received a Result that corresponds to ITS
// OWN request rather than some other caller's, and that this is race
// free under `go test -race` - the naive Collector fails all three,
// since Add mutates shared state with no synchronization at all.
func TestCollectorFiresBatchExactlyOnceAndMapsResultsCorrectly(t *testing.T) {
	const callers = 30

	var mu sync.Mutex
	var callCount int
	var seenBatchSize int

	fn := func(requests []int) ([]int, error) {
		mu.Lock()
		callCount++
		seenBatchSize = len(requests)
		mu.Unlock()

		responses := make([]int, len(requests))
		for i, r := range requests {
			responses[i] = r * 2
		}
		return responses, nil
	}

	c := NewCollector(callers, fn)

	start := make(chan struct{})
	results := make([]Result, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()
			<-start
			ch := c.Add(i)
			results[i] = recvResult(t, ch)
		}()
	}
	close(start)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()

	if callCount != 1 {
		t.Fatalf("fn ran %d time(s) across %d concurrent Add calls, want exactly 1", callCount, callers)
	}

	if seenBatchSize != callers {
		t.Errorf("fn was called with a batch of %d requests, want %d", seenBatchSize, callers)
	}

	for i, result := range results {
		if result.Err != nil {
			t.Errorf("caller %d: got error %v, want nil", i, result.Err)
			continue
		}

		if want := i * 2; result.Value != want {
			t.Errorf("caller %d: got %d, want %d (own request*2) - results must map back to the caller's own request", i, result.Value, want)
		}
	}
}

// TestCollectorPropagatesErrorToAllCallers checks that when fn fails,
// every caller in the batch - not just some of them - observes that
// same error, and none of them get a bogus zero value mistaken for
// success.
func TestCollectorPropagatesErrorToAllCallers(t *testing.T) {
	const callers = 10
	wantErr := errors.New("batch API unavailable")

	fn := func(requests []int) ([]int, error) {
		return nil, wantErr
	}

	c := NewCollector(callers, fn)

	start := make(chan struct{})
	results := make([]Result, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()
			<-start
			results[i] = recvResult(t, c.Add(i))
		}()
	}
	close(start)
	wg.Wait()

	for i, result := range results {
		if !errors.Is(result.Err, wantErr) {
			t.Errorf("caller %d: got error %v, want %v", i, result.Err, wantErr)
		}
	}
}
