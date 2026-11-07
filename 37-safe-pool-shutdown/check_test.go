//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// closeTimeout turns a stuck Close into a fast failure.
const closeTimeout = 3 * time.Second

func closeWithTimeout(t *testing.T, p *Pool) {
	t.Helper()

	done := make(chan struct{})
	go func() {
		p.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(closeTimeout):
		t.Fatalf("Close did not return within %s", closeTimeout)
	}
}

// Every job accepted before Close must run.
func TestSubmitRunsAllJobsSequentially(t *testing.T) {
	p := NewPool(3)

	const n = 20
	var ran int32

	for i := 0; i < n; i++ {
		if accepted := p.Submit(func() { atomic.AddInt32(&ran, 1) }); !accepted {
			t.Fatalf("Submit %d was rejected before Close was ever called", i)
		}
	}

	closeWithTimeout(t, p)

	if ran != n {
		t.Errorf("ran %d job(s), want %d", ran, n)
	}
}

// Submit after Close must return false without panic.
// None of those jobs may run.
func TestSubmitAfterCloseIsRejectedNotPanicked(t *testing.T) {
	p := NewPool(3)

	const preClose = 10
	var preCloseRan int32
	for i := 0; i < preClose; i++ {
		if !p.Submit(func() { atomic.AddInt32(&preCloseRan, 1) }) {
			t.Fatalf("Submit %d was rejected before Close was ever called", i)
		}
	}

	closeWithTimeout(t, p)

	if preCloseRan != preClose {
		t.Fatalf("only %d/%d pre-Close jobs had run by the time Close returned", preCloseRan, preClose)
	}

	const postCloseSubmitters = 50

	var rejected, postCloseRan int32

	var wg sync.WaitGroup
	for i := 0; i < postCloseSubmitters; i++ {
		wg.Add(1)

		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Submit panicked: %v - Submit must never panic, even after Close has already returned", r)
				}
			}()

			if p.Submit(func() { atomic.AddInt32(&postCloseRan, 1) }) {
				t.Errorf("Submit reported accepted = true after Close had already returned - a closed Pool must reject every new job")
				return
			}

			atomic.AddInt32(&rejected, 1)
		}()
	}
	wg.Wait()

	if rejected != postCloseSubmitters {
		t.Errorf("only %d/%d post-Close Submit calls were rejected", rejected, postCloseSubmitters)
	}

	if postCloseRan != 0 {
		t.Errorf("%d job(s) ran after Close had already returned, want 0", postCloseRan)
	}
}

// Submit and Close must be safe when they overlap.
// Every accepted job must run before Close returns.
func TestConcurrentSubmitDuringCloseNeverPanics(t *testing.T) {
	const submitters = 200
	const closeAfter = 10 // Start Close while other callers are active.

	p := NewPool(4)

	var accepted, ran int32
	began := make(chan struct{}, submitters)

	var submitWg sync.WaitGroup
	for i := 0; i < submitters; i++ {
		submitWg.Add(1)

		go func() {
			defer submitWg.Done()
			began <- struct{}{}

			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("Submit panicked: %v - Submit must never panic, even when called concurrently with Close", r)
					}
				}()

				if p.Submit(func() { atomic.AddInt32(&ran, 1) }) {
					atomic.AddInt32(&accepted, 1)
				}
			}()
		}()
	}

	closeDone := make(chan struct{})
	go func() {
		for i := 0; i < closeAfter; i++ {
			<-began
		}
		p.Close()
		close(closeDone)
	}()

	submitWg.Wait()

	select {
	case <-closeDone:
	case <-time.After(closeTimeout):
		t.Fatalf("Close did not return within %s", closeTimeout)
	}

	if ran != accepted {
		t.Errorf("%d job(s) ran but %d were reported accepted - Close must not return until every "+
			"accepted job has finished running, and accepted must be false for any job that won't run", ran, accepted)
	}
}
