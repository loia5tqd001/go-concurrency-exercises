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

// startWithTimeout calls Start and limits how long it waits.
// Start must return before its workers finish.
// An inline wait would deadlock before the producer can send jobs.
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

// TestStartProcessesEveryJob checks the count when done closes.
// The naive code closes done before all jobs finish.
// The fixed code must close done after the last process call.
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
		// Every job must be processed when done closes.
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

// TestStartDoesNotDoubleProcessOrDropJobs checks every job ID once.
// It does not trust done, because the naive code closes it early.
// It waits until all results arrive or the time limit ends.
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

	// Wait for done only as a hint.
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
		default:
			t.Errorf("job %d was processed %d times", id, counts[id])
		}
	}
}

// TestDoneWaitsForInFlightProcessCall checks a blocked process call.
// The test controls when that call ends.
// Done must stay open until process returns.
func TestDoneWaitsForInFlightProcessCall(t *testing.T) {
	jobs := make(chan int)
	started := make(chan struct{})
	proceed := make(chan struct{})

	done := startWithTimeout(t, jobs, func(item int) {
		close(started)
		<-proceed
	})

	select {
	case jobs <- 0:
	case <-time.After(2 * time.Second):
		close(proceed)
		t.Fatal("timed out submitting the job - start returned without a worker receiving from jobs")
	}

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for process to start running on the submitted job")
	}

	close(jobs)

	// process(0) is blocked, so done must stay open.
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
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for done to close after the in-flight job finished")
	}
}
