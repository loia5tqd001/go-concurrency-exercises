//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recvTimeout bounds every channel receive in this file. The naive
// Collector can hang a caller forever (a batch that never reaches
// MaxBatchSize with MaxWait unimplemented, or Close leaving a pending
// batch unflushed) - a bounded receive turns that failure into a
// clear, fast test failure instead of a 10-minute `go test` timeout
// with no useful message.
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

// addWithTimeout bounds the call to Add itself, not just the receive
// from the channel it returns. A Collector that runs fn synchronously
// inside Add (instead of handing the batch to a background goroutine
// once it fires) can block the caller of Add indefinitely - this turns
// that into a clear, fast test failure instead of a 10-minute `go test`
// timeout with no useful message.
func addWithTimeout(t *testing.T, c *Collector, request int) <-chan Result {
	t.Helper()

	out := make(chan (<-chan Result), 1)
	go func() { out <- c.Add(request) }()

	select {
	case ch := <-out:
		return ch
	case <-time.After(recvTimeout):
		t.Fatalf("Add(%d) did not return within %s - Add must never block on fn itself", request, recvTimeout)
		return nil
	}
}

func doubleFn(callCount *int32, mu *sync.Mutex) BatchFunc {
	return func(requests []int) ([]int, error) {
		mu.Lock()
		*callCount++
		mu.Unlock()

		responses := make([]int, len(requests))
		for i, r := range requests {
			responses[i] = r * 2
		}
		return responses, nil
	}
}

// TestCollectorFiresOnMaxBatchSize checks the straightforward case:
// MaxBatchSize concurrent callers, fn runs once with all of them, and
// each gets back the response matching its own request.
func TestCollectorFiresOnMaxBatchSize(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: 5, MaxWait: time.Hour}, doubleFn(&callCount, &mu))

	results := make([]Result, 5)
	var wg sync.WaitGroup
	wg.Add(5)
	for i := 0; i < 5; i++ {
		i := i
		go func() {
			defer wg.Done()
			results[i] = recvResult(t, c.Add(i))
		}()
	}
	wg.Wait()

	for i, r := range results {
		if r.Err != nil {
			t.Errorf("caller %d: got error %v, want nil", i, r.Err)
		}
		if want := i * 2; r.Value != want {
			t.Errorf("caller %d: got %d, want %d", i, r.Value, want)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if callCount != 1 {
		t.Errorf("fn ran %d time(s), want exactly 1", callCount)
	}
}

// TestCollectorFiresOnMaxWaitWithPartialBatch checks the other
// trigger: a batch far short of MaxBatchSize must still fire, and
// still deliver correct results, once MaxWait elapses.
func TestCollectorFiresOnMaxWaitWithPartialBatch(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: 100, MaxWait: 50 * time.Millisecond}, doubleFn(&callCount, &mu))

	ch0 := c.Add(10)
	ch1 := c.Add(20)

	r0 := recvResult(t, ch0)
	r1 := recvResult(t, ch1)

	if r0.Err != nil || r0.Value != 20 {
		t.Errorf("caller 0: got Result{%d, %v}, want {20, nil}", r0.Value, r0.Err)
	}
	if r1.Err != nil || r1.Value != 40 {
		t.Errorf("caller 1: got Result{%d, %v}, want {40, nil}", r1.Value, r1.Err)
	}

	mu.Lock()
	defer mu.Unlock()
	if callCount != 1 {
		t.Errorf("fn ran %d time(s), want exactly 1", callCount)
	}
}

// TestCollectorNeverDoubleFiresWhenCountAndWaitRace races the
// count-trigger against the deadline-trigger for the same batch: both
// Adds run concurrently against a MaxWait so small it can plausibly
// fire before, during, or after the batch-completing Add reaches
// MaxBatchSize. A tiny MaxWait under concurrent load can legitimately
// split this into more than one batch (the second Add loses the race
// for the first batch entirely and opens a fresh one) - that's not a
// bug, so this test doesn't assert a single fn call. What it does
// assert is the invariant a double-fire would actually violate: the
// same batch running fn twice would double-count its own requests, so
// the total requests processed across every fn call this trial must
// equal exactly the 2 requests submitted.
func TestCollectorNeverDoubleFiresWhenCountAndWaitRace(t *testing.T) {
	const trials = 200

	for trial := 0; trial < trials; trial++ {
		var totalProcessed int32
		fn := func(requests []int) ([]int, error) {
			atomic.AddInt32(&totalProcessed, int32(len(requests)))
			responses := make([]int, len(requests))
			for i, r := range requests {
				responses[i] = r * 2
			}
			return responses, nil
		}

		c := NewCollector(Config{MaxBatchSize: 2, MaxWait: time.Microsecond}, fn)

		var ch0, ch1 <-chan Result
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); ch0 = c.Add(0) }()
		go func() { defer wg.Done(); ch1 = c.Add(1) }()
		wg.Wait()

		recvResult(t, ch0)
		recvResult(t, ch1)

		if got := atomic.LoadInt32(&totalProcessed); got != 2 {
			t.Fatalf("trial %d: fn processed %d total request(s) across all its calls this trial, want exactly 2 - a double-fire would double-count one", trial, got)
		}
	}
}

// TestCollectorRollsOverToNewBatchAfterFiring checks that the
// Collector keeps working indefinitely: three back-to-back batches,
// each mapping its own callers to its own results without crosstalk
// with either of the other two.
func TestCollectorRollsOverToNewBatchAfterFiring(t *testing.T) {
	const batchSize = 4
	const batches = 3

	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: batchSize, MaxWait: time.Hour}, doubleFn(&callCount, &mu))

	for b := 0; b < batches; b++ {
		base := b * 100
		results := make([]Result, batchSize)
		var wg sync.WaitGroup
		wg.Add(batchSize)
		for i := 0; i < batchSize; i++ {
			i := i
			go func() {
				defer wg.Done()
				results[i] = recvResult(t, c.Add(base+i))
			}()
		}
		wg.Wait()

		for i, r := range results {
			if want := (base + i) * 2; r.Value != want || r.Err != nil {
				t.Errorf("batch %d caller %d: got Result{%d, %v}, want {%d, nil}", b, i, r.Value, r.Err, want)
			}
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if callCount != batches {
		t.Errorf("fn ran %d time(s), want exactly %d (one per batch)", callCount, batches)
	}
}

// TestCollectorPropagatesErrorToAllCallers checks that when fn fails,
// every caller in the batch - not just some of them - observes that
// same error, and none of them get a bogus zero value mistaken for
// success.
func TestCollectorPropagatesErrorToAllCallers(t *testing.T) {
	const callers = 6
	wantErr := errors.New("batch API unavailable")

	fn := func(requests []int) ([]int, error) { return nil, wantErr }
	c := NewCollector(Config{MaxBatchSize: callers, MaxWait: time.Hour}, fn)

	results := make([]Result, callers)
	var wg sync.WaitGroup
	wg.Add(callers)
	for i := 0; i < callers; i++ {
		i := i
		go func() {
			defer wg.Done()
			results[i] = recvResult(t, c.Add(i))
		}()
	}
	wg.Wait()

	for i, r := range results {
		if !errors.Is(r.Err, wantErr) {
			t.Errorf("caller %d: got error %v, want %v", i, r.Err, wantErr)
		}
	}
}

// TestCollectorCloseRejectsSubsequentAdds checks that once Close has
// returned, every later Add gets ErrCollectorClosed immediately -
// never silently queued into a batch that will never fire, never a
// hang.
func TestCollectorCloseRejectsSubsequentAdds(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: 5, MaxWait: time.Hour}, doubleFn(&callCount, &mu))

	ctx, cancel := context.WithTimeout(context.Background(), recvTimeout)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	r := recvResult(t, c.Add(1))
	if !errors.Is(r.Err, ErrCollectorClosed) {
		t.Errorf("Add after Close: got err %v, want %v", r.Err, ErrCollectorClosed)
	}
}

// TestCollectorCloseFlushesPendingPartialBatch checks that Close
// doesn't abandon whatever's already queued - it fires that partial
// batch as one last call to fn, and every caller in it still gets a
// real value back, not an error.
func TestCollectorCloseFlushesPendingPartialBatch(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: 100, MaxWait: time.Hour}, doubleFn(&callCount, &mu))

	ch0 := c.Add(10)
	ch1 := c.Add(20)

	ctx, cancel := context.WithTimeout(context.Background(), recvTimeout)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	r0 := recvResult(t, ch0)
	r1 := recvResult(t, ch1)

	if r0.Err != nil || r0.Value != 20 {
		t.Errorf("caller 0: got Result{%d, %v}, want {20, nil}", r0.Value, r0.Err)
	}
	if r1.Err != nil || r1.Value != 40 {
		t.Errorf("caller 1: got Result{%d, %v}, want {40, nil}", r1.Value, r1.Err)
	}

	mu.Lock()
	defer mu.Unlock()
	if callCount != 1 {
		t.Errorf("fn ran %d time(s), want exactly 1", callCount)
	}
}

// TestCollectorCloseConcurrentWithAdd hammers Add and Close from many
// goroutines at once. Every caller - whether it lands in a batch that
// fires or arrives too late to be accepted - must get SOME Result
// within the bound, never a hang, and go test -race must stay clean.
func TestCollectorCloseConcurrentWithAdd(t *testing.T) {
	var callCount int32
	var mu sync.Mutex

	c := NewCollector(Config{MaxBatchSize: 10, MaxWait: 10 * time.Millisecond}, doubleFn(&callCount, &mu))

	const callers = 50
	var wg sync.WaitGroup
	wg.Add(callers + 1)

	go func() {
		defer wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), recvTimeout)
		defer cancel()
		c.Close(ctx)
	}()

	for i := 0; i < callers; i++ {
		i := i
		go func() {
			defer wg.Done()
			recvResult(t, c.Add(i))
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Add/Close under concurrency never completed - looks wedged")
	}
}

// TestCollectorCloseRespectsContextDeadline checks Close's
// http.Server.Shutdown-style contract: it returns ctx's error the
// moment ctx expires, rather than blocking until a slow, already
// in-flight batch finishes on its own - though that batch must still
// go on to complete in the background regardless.
func TestCollectorCloseRespectsContextDeadline(t *testing.T) {
	batchStarted := make(chan struct{})
	release := make(chan struct{})

	fn := func(requests []int) ([]int, error) {
		close(batchStarted)
		<-release

		responses := make([]int, len(requests))
		for i, r := range requests {
			responses[i] = r * 2
		}
		return responses, nil
	}

	c := NewCollector(Config{MaxBatchSize: 2, MaxWait: time.Hour}, fn)

	ch0 := addWithTimeout(t, c, 1)
	ch1 := addWithTimeout(t, c, 2) // pushes MaxBatchSize, fn starts running in the background

	select {
	case <-batchStarted:
	case <-time.After(recvTimeout):
		t.Fatal("fn never started")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := c.Close(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Close returned %v, want context.DeadlineExceeded", err)
	}

	close(release)

	if r := recvResult(t, ch0); r.Value != 2 {
		t.Errorf("caller 0: got %d, want 2 (the batch must still complete in the background)", r.Value)
	}
	if r := recvResult(t, ch1); r.Value != 4 {
		t.Errorf("caller 1: got %d, want 4", r.Value)
	}
}
