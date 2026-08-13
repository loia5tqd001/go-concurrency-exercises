//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"testing"
	"time"
)

// TestWorkerInboxIsUnbuffered guards the exercise's static constraint:
// Worker.requests must stay unbuffered. This exercise is about making
// Balance correct without a buffer to lean on - bumping the capacity
// back up would sidestep the actual task instead of solving it.
func TestWorkerInboxIsUnbuffered(t *testing.T) {
	b := NewBalancer(3)
	for _, w := range b.pool {
		if c := cap(w.requests); c != 0 {
			t.Fatalf("Worker.requests has capacity %d; this exercise requires "+
				"an unbuffered inbox (capacity 0) - solve dispatch without "+
				"leaning on a buffer", c)
		}
	}
}

// TestBalancerCompletesABurstNoBiggerThanThePool submits exactly as
// many requests as there are workers, all at once. Every request gets
// its own idle worker on the very first round of dispatch - a fresh
// Worker is always parked on a receive, so even an unbuffered inbox
// accepts the send immediately. This passes against the naive
// implementation too; the bug doesn't show up until a Worker that's
// already busy (or already reporting back on done) needs a second
// request.
func TestBalancerCompletesABurstNoBiggerThanThePool(t *testing.T) {
	const numWorkers = 4

	b := NewBalancer(numWorkers)
	work := make(chan Request)
	go b.Balance(work)

	results := make([]chan int, numWorkers)
	for i := range results {
		i := i
		results[i] = make(chan int, 1)
		req := Request{
			fn: func() int {
				time.Sleep(20 * time.Millisecond)
				return i * i
			},
			c: results[i],
		}
		select {
		case work <- req:
		case <-time.After(time.Second):
			t.Fatalf("request %d was never dispatched", i)
		}
	}

	for i, c := range results {
		select {
		case got := <-c:
			if want := i * i; got != want {
				t.Errorf("request %d = %d, want %d", i, got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("request %d never completed", i)
		}
	}
}

// TestBalancerSurvivesBackToBackRequestsOnOneWorker is the key test.
// A single Worker gets several requests in a row, faster than it can
// drain them - with a buffered inbox (exercise 33) this just queues;
// with an unbuffered one, the naive Balance blocks on the very first
// send to a Worker that isn't parked on a receive yet, and can never
// reach b.done to unblock it. Every request must still complete.
func TestBalancerSurvivesBackToBackRequestsOnOneWorker(t *testing.T) {
	const numWorkers = 1
	const numRequests = 5

	b := NewBalancer(numWorkers)
	work := make(chan Request)
	go b.Balance(work)

	results := make([]int, numRequests)

	var wg sync.WaitGroup
	wg.Add(numRequests)
	var start sync.WaitGroup
	start.Add(1)
	for i := 0; i < numRequests; i++ {
		i := i
		go func() {
			defer wg.Done()
			start.Wait()

			c := make(chan int, 1)
			req := Request{
				fn: func() int {
					time.Sleep(20 * time.Millisecond)
					return i + 1
				},
				c: c,
			}

			select {
			case work <- req:
			case <-time.After(2 * time.Second):
				t.Errorf("request %d was never dispatched - balancer looks wedged", i)
				return
			}

			select {
			case v := <-c:
				results[i] = v
			case <-time.After(2 * time.Second):
				t.Errorf("request %d never completed", i)
			}
		}()
	}
	start.Done()

	allDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(allDone)
	}()

	select {
	case <-allDone:
	case <-time.After(3 * time.Second):
		t.Fatal("not all requests completed within 3s - the balancer appears to " +
			"deadlock once a single Worker's unbuffered inbox has to absorb " +
			"back-to-back requests")
	}

	for i, got := range results {
		if want := i + 1; got != want {
			t.Errorf("request %d result = %d, want %d", i, got, want)
		}
	}
}

// TestBalancerSurvivesMoreRequestsThanWorkers mirrors 33's own key
// test at a larger scale, to catch a design that only happens to
// survive the single-worker case above.
func TestBalancerSurvivesMoreRequestsThanWorkers(t *testing.T) {
	const numWorkers = 3
	const numRequests = numWorkers * 4

	b := NewBalancer(numWorkers)
	work := make(chan Request)
	go b.Balance(work)

	results := make([]int, numRequests)

	var wg sync.WaitGroup
	wg.Add(numRequests)
	for i := 0; i < numRequests; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := make(chan int, 1)
			req := Request{
				fn: func() int {
					time.Sleep(5 * time.Millisecond)
					return i + 1
				},
				c: c,
			}

			select {
			case work <- req:
			case <-time.After(2 * time.Second):
				t.Errorf("request %d was never dispatched - balancer looks wedged", i)
				return
			}

			select {
			case v := <-c:
				results[i] = v
			case <-time.After(2 * time.Second):
				t.Errorf("request %d never completed", i)
			}
		}()
	}

	allDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(allDone)
	}()

	select {
	case <-allDone:
	case <-time.After(3 * time.Second):
		t.Fatal("not all requests completed within 3s - the balancer appears to deadlock")
	}

	for i, got := range results {
		if want := i + 1; got != want {
			t.Errorf("request %d result = %d, want %d", i, got, want)
		}
	}
}

// TestBalancerConcurrentSafety hammers the balancer with many
// concurrent submitters to catch data races in the pool's heap and
// backlog bookkeeping (run with go test -race).
func TestBalancerConcurrentSafety(t *testing.T) {
	const numWorkers = 5
	const numRequests = 100

	b := NewBalancer(numWorkers)
	work := make(chan Request)
	go b.Balance(work)

	var wg sync.WaitGroup
	wg.Add(numRequests)
	for i := 0; i < numRequests; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := make(chan int, 1)
			work <- Request{
				fn: func() int { return i },
				c:  c,
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
