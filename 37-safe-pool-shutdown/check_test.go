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

// closeTimeout bounds how long we'll wait for Close to return. The
// naive Pool can deadlock (a lost sync.WaitGroup Add/Done pairing, or
// a straggler goroutine blocked forever trying to send on a channel
// nobody will ever read from again), so this turns that into a clear,
// fast test failure instead of a 10-minute `go test` timeout.
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

// TestSubmitRunsAllJobsSequentially is the uncontended baseline: every
// Submit call made before Close is ever invoked must be accepted, and
// must have actually run by the time Close returns.
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

// TestSubmitAfterCloseIsRejectedNotPanicked is the deterministic core
// test. It submits a few jobs, closes the pool, WAITS for Close to
// fully return, and only then fires a burst of concurrent Submit
// calls - each one guaranteed to happen strictly after the pool is
// already closed. Every naive Pool, on every run, sends on an
// already-closed channel here and panics: there is no scheduling luck
// involved, since Close has unambiguously already finished by the
// time these calls start. A correct Pool must reject every one of
// them (accepted = false), run none of their jobs, and never let a
// panic escape Submit.
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

// TestConcurrentSubmitDuringCloseNeverPanics goes further than the
// deterministic test above: `submitters` goroutines call Submit at
// once, racing against a single concurrent call to Close, so some
// calls genuinely overlap the shutdown itself rather than landing
// cleanly before or after it. It checks that no panic ever escapes
// Submit under that overlap, and that every job Submit reported as
// accepted actually ran by the time Close returns - ruling out a
// "fix" that silently drops jobs once shutdown starts instead of
// honestly reporting accepted = false for them. Run with `go test
// -race`, where the added instrumentation overhead makes the race
// window reliably wide enough to hit.
func TestConcurrentSubmitDuringCloseNeverPanics(t *testing.T) {
	const submitters = 200
	const closeAfter = 10 // start Close early, while most callers are still mid-flight

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
