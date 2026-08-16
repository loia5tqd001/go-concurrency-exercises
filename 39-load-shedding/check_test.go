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

// TestAcceptedJobsEventuallyComplete is the baseline: under no
// particular load, every submitted job must be accepted and must
// eventually complete with the right result.
func TestAcceptedJobsEventuallyComplete(t *testing.T) {
	const workers = 3
	const capacity = 30
	const numJobs = 12

	q := NewQueue(workers, capacity)

	results := make([]chan int, numJobs)
	for i := range results {
		i := i
		results[i] = make(chan int, 1)
		job := Job{
			Run: func() int {
				time.Sleep(5 * time.Millisecond)
				return i * i
			},
			Result: results[i],
		}
		if err := q.Submit(job); err != nil {
			t.Fatalf("job %d: expected Submit to succeed under light load, got %v", i, err)
		}
	}

	for i, c := range results {
		select {
		case got := <-c:
			if want := i * i; got != want {
				t.Errorf("job %d = %d, want %d", i, got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("job %d never completed", i)
		}
	}
}

// TestSubmitFailsFastWhenQueueIsFull is the key test. It saturates the
// Queue - fills every worker plus the entire backlog with jobs that
// won't complete until the test says so - then keeps calling Submit
// until it observes ErrOverloaded. Two things must hold: no individual
// Submit call is ever allowed to block for more than a short deadline,
// and ErrOverloaded must actually be observed once real capacity is
// exceeded.
//
// Against the naive implementation, Submit blocks on the channel send
// once jobs is full, so the attempt that would need to wait hangs past
// this test's deadline instead of returning.
func TestSubmitFailsFastWhenQueueIsFull(t *testing.T) {
	const workers = 1
	const capacity = 2
	const perCallDeadline = 200 * time.Millisecond

	q := NewQueue(workers, capacity)

	block := make(chan struct{})
	defer close(block) // let every blocked Run finish so no goroutine leaks past the test

	submit := func(job Job) (err error, returnedInTime bool) {
		done := make(chan error, 1)
		go func() { done <- q.Submit(job) }()
		select {
		case err := <-done:
			return err, true
		case <-time.After(perCallDeadline):
			return nil, false
		}
	}

	sawOverloaded := false
	// Generous margin over the true ceiling (capacity + one job in
	// flight per worker), so this doesn't depend on pinning that exact
	// bookkeeping.
	const attempts = capacity + workers + 5
	for i := 0; i < attempts; i++ {
		job := Job{
			Run:    func() int { <-block; return 0 },
			Result: make(chan int, 1),
		}
		err, ok := submit(job)
		if !ok {
			t.Fatalf("Submit attempt %d blocked for over %s instead of failing fast - "+
				"looks like it's still a blocking send instead of select/default", i, perCallDeadline)
		}
		if err != nil {
			if !errors.Is(err, ErrOverloaded) {
				t.Fatalf("Submit attempt %d returned an unexpected error: %v", i, err)
			}
			sawOverloaded = true
			break
		}
	}

	if !sawOverloaded {
		t.Fatalf("expected ErrOverloaded within %d submits once the queue is saturated, got none", attempts)
	}
}

// TestQueueConcurrentSafety hammers the Queue with many concurrent
// submitters to catch data races (run with go test -race). Capacity is
// sized generously relative to the load, so ErrOverloaded is expected
// to be rare; a submitter retries a few times before giving up, since
// a transient rejection under heavy concurrent load isn't itself a
// bug.
func TestQueueConcurrentSafety(t *testing.T) {
	const workers = 5
	const capacity = 200
	const numJobs = 100
	const maxRetries = 20

	q := NewQueue(workers, capacity)

	var wg sync.WaitGroup
	wg.Add(numJobs)
	for i := 0; i < numJobs; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := make(chan int, 1)
			job := Job{
				Run:    func() int { return i },
				Result: c,
			}

			var err error
			for attempt := 0; attempt < maxRetries; attempt++ {
				if err = q.Submit(job); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if err != nil {
				t.Errorf("job %d: never got admitted after %d retries: %v", i, maxRetries, err)
				return
			}

			<-c
		}()
	}

	allDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(allDone)
	}()

	select {
	case <-allDone:
	case <-time.After(5 * time.Second):
		t.Fatal("jobs never completed under concurrent load")
	}
}
