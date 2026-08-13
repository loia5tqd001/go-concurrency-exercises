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

// TestAcceptedRequestsEventuallyComplete is the baseline: under no
// particular load, every submitted request must be accepted and must
// eventually complete with the right result.
func TestAcceptedRequestsEventuallyComplete(t *testing.T) {
	const numWorkers = 3
	const maxBacklog = 30
	const numRequests = 12

	b := NewBalancer(numWorkers, maxBacklog)

	results := make([]chan int, numRequests)
	for i := range results {
		i := i
		results[i] = make(chan int, 1)
		req := Request{
			fn: func() int {
				time.Sleep(5 * time.Millisecond)
				return i * i
			},
			c: results[i],
		}
		if err := b.Submit(req); err != nil {
			t.Fatalf("request %d: expected Submit to succeed under light load, got %v", i, err)
		}
	}

	for i, c := range results {
		select {
		case got := <-c:
			if want := i * i; got != want {
				t.Errorf("request %d = %d, want %d", i, got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("request %d never completed", i)
		}
	}
}

// TestSubmitFailsFastWhenSaturated is the key test. It saturates the
// balancer - fills every Worker plus the entire incoming backlog with
// requests that won't complete until the test says so - then keeps
// calling Submit until it observes ErrOverloaded. Two things must
// hold: no individual Submit call is ever allowed to block for more
// than a short deadline, and ErrOverloaded must actually be observed
// once real capacity is exceeded.
//
// Against the naive implementation, Submit blocks on an unbuffered
// send once incoming is full, so the attempt that would need to wait
// hangs past this test's deadline instead of returning.
func TestSubmitFailsFastWhenSaturated(t *testing.T) {
	const numWorkers = 1
	const maxBacklog = 2
	const perCallDeadline = 200 * time.Millisecond

	b := NewBalancer(numWorkers, maxBacklog)

	block := make(chan struct{})
	defer close(block) // let every blocked fn finish so no goroutine leaks past the test

	submit := func(req Request) (err error, returnedInTime bool) {
		done := make(chan error, 1)
		go func() { done <- b.Submit(req) }()
		select {
		case err := <-done:
			return err, true
		case <-time.After(perCallDeadline):
			return nil, false
		}
	}

	sawOverloaded := false
	// Generous margin over the true ceiling (maxBacklog + the run
	// loop's own one-item staging slot + numWorkers in flight), so this
	// doesn't depend on pinning that exact bookkeeping.
	const attempts = maxBacklog + numWorkers + 5
	for i := 0; i < attempts; i++ {
		req := Request{
			fn: func() int { <-block; return 0 },
			c:  make(chan int, 1),
		}
		err, ok := submit(req)
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
		t.Fatalf("expected ErrOverloaded within %d submits once the balancer is saturated, got none", attempts)
	}
}

// TestBalancerConcurrentSafety hammers the balancer with many
// concurrent submitters to catch data races in the pool's heap and
// dispatch bookkeeping (run with go test -race). Capacity is sized
// generously relative to the load, so ErrOverloaded is expected to be
// rare; a submitter retries a few times before giving up, since a
// transient rejection under heavy concurrent load isn't itself a bug.
func TestBalancerConcurrentSafety(t *testing.T) {
	const numWorkers = 5
	const maxBacklog = 200
	const numRequests = 100
	const maxRetries = 20

	b := NewBalancer(numWorkers, maxBacklog)

	var wg sync.WaitGroup
	wg.Add(numRequests)
	for i := 0; i < numRequests; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := make(chan int, 1)
			req := Request{
				fn: func() int { return i },
				c:  c,
			}

			var err error
			for attempt := 0; attempt < maxRetries; attempt++ {
				if err = b.Submit(req); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if err != nil {
				t.Errorf("request %d: never got admitted after %d retries: %v", i, maxRetries, err)
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
		t.Fatal("requests never completed under concurrent load")
	}
}
