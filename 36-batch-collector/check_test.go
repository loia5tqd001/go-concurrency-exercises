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

// recvTimeout turns a missing batch result into a fast failure.
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

// addWithTimeout checks that Add itself returns quickly.
// Add must not run fn on the caller's goroutine.
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

// A full batch must run fn once and match every caller.
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

// A partial batch must fire when MaxWait ends.
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

// Size and timeout can race.
// The race may create one batch or two.
// Either way, the two requests must each run exactly once.
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

// Each new batch must send results only to its own callers.
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

// When fn fails, every caller must receive the same error.
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

// Add after Close must return ErrCollectorClosed.
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

// Close must flush a partial batch and return real values.
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

// Add and Close must be safe together.
// Every caller must get a Result without hanging.
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

// Close must return ctx.Err() when ctx ends first.
// The running batch must still finish in the background.
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
	ch1 := addWithTimeout(t, c, 2) // This starts fn in the background.

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
