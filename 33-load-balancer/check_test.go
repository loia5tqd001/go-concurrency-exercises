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

// A burst no larger than the pool must complete.
// This passes even with the broken Balance.
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

// More requests than workers must all complete.
// The broken Balance blocks after each worker finishes its first job.
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
		t.Fatal("not all requests completed within 3s - the balancer appears to " +
			"deadlock once more requests arrive than there are workers to " +
			"immediately absorb them")
	}

	for i, got := range results {
		if want := i + 1; got != want {
			t.Errorf("request %d result = %d, want %d", i, got, want)
		}
	}
}

// Concurrent submitters must not race on heap bookkeeping.
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
