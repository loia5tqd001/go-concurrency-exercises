//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

// Worker.requests must stay unbuffered.
// Adding a buffer would avoid the exercise.
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

// A burst no larger than the pool must complete.
// Each request goes to an idle worker.
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

// One worker must handle several queued requests.
// The broken Balance blocks when that worker is busy.
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

// Several workers must also handle more requests than they can run.
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

// Waiting requests must be stored in Balance, not one goroutine each.
// A goroutine per request hides the blocking send but costs too much.
// A round-robin design that ignores the heap has the same problem.
func TestBalancerQueuesWithoutASeparateGoroutinePerRequest(t *testing.T) {
	const numWorkers = 2
	const numRequests = 50

	runtime.GC()
	baseline := runtime.NumGoroutine()

	b := NewBalancer(numWorkers)
	work := make(chan Request)
	go b.Balance(work)

	// Send from this goroutine so the count stays stable.
	// Balance must accept queued work without waiting.
	results := make([]chan int, numRequests)
	for i := 0; i < numRequests; i++ {
		i := i
		c := make(chan int, 1)
		results[i] = c
		req := Request{
			fn: func() int {
				time.Sleep(20 * time.Millisecond)
				return i
			},
			c: c,
		}
		select {
		case work <- req:
		case <-time.After(2 * time.Second):
			t.Fatalf("request %d was never dispatched - balancer looks wedged", i)
		}
	}

	// Only workers can run jobs. Balance must hold the rest.
	time.Sleep(50 * time.Millisecond)
	if delta := runtime.NumGoroutine() - baseline; delta > numWorkers+10 {
		t.Fatalf("goroutine count grew by %d while %d requests were queued "+
			"against %d workers (want at most ~%d); Balance looks like it's "+
			"spawning a goroutine per request to dodge the blocking send "+
			"instead of queuing internally", delta, numRequests, numWorkers, numWorkers+10)
	}

	for i, c := range results {
		select {
		case <-c:
		case <-time.After(2 * time.Second):
			t.Fatalf("request %d never completed", i)
		}
	}

	// After completion, no sender goroutines should remain.
	time.Sleep(50 * time.Millisecond)
	if delta := runtime.NumGoroutine() - baseline; delta > numWorkers+10 {
		t.Fatalf("goroutine count is still %d above baseline after every request "+
			"completed (want at most ~%d); something is leaking a goroutine per "+
			"request instead of letting it exit once delivered", delta, numWorkers+10)
	}
}

// Concurrent submitters must not race on heap or backlog data.
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
