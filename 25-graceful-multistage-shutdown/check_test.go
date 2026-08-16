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

// startWithTimeout calls Start in the background and waits for it to
// return, with a bounded timeout. Start is documented to return
// immediately - whatever it does to wait for its workers has to
// happen concurrently with that return, not block it - so every test
// below goes through this helper instead of calling Start directly.
// A plausible near-miss implementation calls wg.Wait() inline inside
// Start (instead of handing the wait off to its own goroutine before
// returning); against that bug, a direct `done := Start(...)` call
// never returns at all, and the jobs producer below it never runs -
// total deadlock, hanging every test toward Go's default 10-minute
// timeout instead of failing fast.
func startWithTimeout(t *testing.T, jobs <-chan int, process func(item int)) <-chan struct{} {
	t.Helper()

	result := make(chan (<-chan struct{}), 1) // buffered: goroutine can't leak if we time out
	go func() {
		result <- Start(jobs, process)
	}()

	select {
	case done := <-result:
		return done
	case <-time.After(2 * time.Second):
		t.Fatalf("Start did not return within 2s - it must hand back the done " +
			"channel immediately and do its waiting in the background, not block")
		return nil
	}
}

// TestStartProcessesEveryJob submits a batch of jobs, closes jobs, and
// waits for done to fire - with a bounded real-time timeout as a
// safety net, since a correct implementation always finishes and the
// naive one closes done instantly anyway, so there is no risk of an
// indefinite hang either way. The moment done fires, it checks how
// many jobs have actually finished being processed.
//
// On the naive implementation, done closes almost immediately - long
// before any (or at best a handful) of the numJobs calls to process
// have completed - so processedCount will be far short of numJobs at
// that exact instant. A correct implementation only closes done after
// every worker has fully drained jobs and returned from its last call
// to process, so processedCount must already equal numJobs the moment
// done fires.
func TestStartProcessesEveryJob(t *testing.T) {
	const numJobs = 20

	jobs := make(chan int)
	go func() {
		for i := 0; i < numJobs; i++ {
			jobs <- i
		}
		close(jobs)
	}()

	var processedCount int64
	done := startWithTimeout(t, jobs, func(item int) {
		time.Sleep(5 * time.Millisecond)
		atomic.AddInt64(&processedCount, 1)
	})

	select {
	case <-done:
		// Check immediately, right as done fires - a correct
		// implementation guarantees every job already finished
		// processing by this exact point in time.
		if got := atomic.LoadInt64(&processedCount); got != numJobs {
			t.Errorf("done closed with %d/%d jobs actually processed; "+
				"done must only close once every submitted job has been "+
				"FULLY processed, not merely received off the jobs channel",
				got, numJobs)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for done to close")
	}
}

// TestStartDoesNotDoubleProcessOrDropJobs is a correctness check that
// is independent of the done-timing bug under test above: it submits
// a batch of jobs and verifies every job ID is processed exactly
// once - no drops, no duplicates, no data races on the shared slice.
//
// It deliberately does NOT trust `done` for its own synchronization,
// since the naive implementation's workers keep running in the
// background even after done closes early - trusting done here would
// make this test flaky/wrong against the very bug #1 exists to catch.
// Instead it polls the collected results until they stabilize at the
// expected count (or a generous timeout elapses), so it passes
// against both the naive and a correct implementation.
func TestStartDoesNotDoubleProcessOrDropJobs(t *testing.T) {
	const numJobs = 50

	jobs := make(chan int)
	go func() {
		for i := 0; i < numJobs; i++ {
			jobs <- i
		}
		close(jobs)
	}()

	var mu sync.Mutex
	var seen []int

	done := startWithTimeout(t, jobs, func(item int) {
		mu.Lock()
		seen = append(seen, item)
		mu.Unlock()
	})

	// Don't rely on done for correctness (see comment above) - just
	// wait for it too, best-effort, before polling below.
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(seen)
		mu.Unlock()

		if n >= numJobs || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()

	if len(seen) != numJobs {
		t.Fatalf("expected exactly %d processed jobs, got %d: %v", numJobs, len(seen), seen)
	}

	counts := make(map[int]int, numJobs)
	for _, id := range seen {
		counts[id]++
	}

	for id := 0; id < numJobs; id++ {
		switch counts[id] {
		case 0:
			t.Errorf("job %d was never processed", id)
		case 1:
			// exactly right
		default:
			t.Errorf("job %d was processed %d times", id, counts[id])
		}
	}
}

// TestDoneWaitsForInFlightProcessCall is a deterministic reproduction
// of the exact bug this exercise is about, with no dependence on
// sleep durations or scheduler luck: it submits a single job whose
// process call blocks on a channel the test controls, and checks that
// done does NOT fire while that call is still blocked - only once the
// test releases it.
//
// This closes a gap the timing-based checks above leave open: an
// implementation that fires done after guessing a "long enough" fixed
// delay (instead of genuinely waiting on the workers), or one that
// hands work off to process asynchronously (e.g. `go process(item)`
// inside the range loop, so the loop itself drains and returns before
// process actually finishes), can slip past a check that only ever
// samples timing - because in-flight work here is blocked
// indefinitely until this test says otherwise, no fixed delay and no
// asynchronous hand-off can win the race.
func TestDoneWaitsForInFlightProcessCall(t *testing.T) {
	jobs := make(chan int)
	started := make(chan struct{})
	proceed := make(chan struct{})

	done := startWithTimeout(t, jobs, func(item int) {
		close(started)
		<-proceed
	})

	jobs <- 0

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for process to start running on the submitted job")
	}

	close(jobs)

	// process(0) is still blocked inside the call above - done must
	// not have fired yet, no matter how long we wait, since nothing
	// but this test can unblock it.
	select {
	case <-done:
		t.Fatal("done closed while a worker was still inside process() - " +
			"done must only close once every submitted job has FULLY finished, " +
			"not merely been received off jobs")
	case <-time.After(200 * time.Millisecond):
		// expected: done has not fired
	}

	close(proceed) // let the blocked worker finish its process() call

	select {
	case <-done:
		// correct: done only fires after the in-flight call completes
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for done to close after the in-flight job finished")
	}
}
