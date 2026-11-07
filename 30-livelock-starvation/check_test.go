//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"testing"
	"testing/synctest"
	"time"
)

// Both workers must make progress after the backoff is jittered.
// The fake clock resolves sleeps without waiting in real time.
// The elapsed check rejects a solution that skips the required protocol.
func TestLivelockBothWorkersMakeProgress(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const attempts = 50
		const floor = attempts / 4 // Neither worker should be near zero.

		// This is below one probeWindow but above the minimum cost.
		const minRoundOverhead = 500 * time.Microsecond
		minElapsed := time.Duration(attempts) * minRoundOverhead

		start := time.Now()
		aProgress, bProgress := RunLivelockDemo(attempts)
		elapsed := time.Since(start)

		if aProgress < floor {
			t.Errorf("worker A only made %d/%d attempts of progress (floor %d) - looks livelocked", aProgress, attempts, floor)
		}
		if bProgress < floor {
			t.Errorf("worker B only made %d/%d attempts of progress (floor %d) - looks livelocked", bProgress, attempts, floor)
		}
		if elapsed < minElapsed {
			t.Errorf("RunLivelockDemo returned after only %v of (fake) time for %d attempts (want >= %v) - "+
				"looks like it isn't running the required announce/settle/backoff protocol",
				elapsed, attempts, minElapsed)
		}
	})
}

// Low-priority jobs must still run when no high-priority work waits.
func TestDispatcherServicesQueuedJobsWhenAvailable(t *testing.T) {
	d := NewDispatcher()
	d.SubmitLowPriority(1)
	d.SubmitLowPriority(2)

	highCompleted, lowCompleted := d.RunDispatchCycles(2)

	if highCompleted != 0 || lowCompleted != 2 {
		t.Fatalf("expected 0 high-priority and 2 low-priority completions, got high=%d low=%d", highCompleted, lowCompleted)
	}
}

// A low-priority job must finish within this many cycles.
const maxLowWaitCycles = 10

// One low-priority job must run despite a deep high-priority backlog.
func TestDispatcherLowPriorityBoundedWait(t *testing.T) {
	d := NewDispatcher()

	const highBacklog = maxLowWaitCycles * 100 // This backlog cannot empty in time.
	for i := 0; i < highBacklog; i++ {
		d.SubmitHighPriority(i)
	}
	d.SubmitLowPriority(1)

	for cycle := 1; cycle <= maxLowWaitCycles; cycle++ {
		_, lowCompleted := d.RunDispatchCycles(1)
		if lowCompleted == 1 {
			return
		}
	}
	t.Fatalf("low-priority job wasn't serviced within %d cycles despite a %d-job high-priority backlog", maxLowWaitCycles, highBacklog)
}

// The oldest low-priority job must win when several are waiting.
func TestDispatcherLowPriorityQueueKeepsFIFOOrder(t *testing.T) {
	d := NewDispatcher()

	const highBacklog = maxLowWaitCycles * 100
	for i := 0; i < highBacklog; i++ {
		d.SubmitHighPriority(i)
	}
	for i := 0; i < 5; i++ {
		d.SubmitLowPriority(i)
	}

	for cycle := 1; cycle <= maxLowWaitCycles; cycle++ {
		_, lowCompleted := d.RunDispatchCycles(1)
		if lowCompleted == 1 {
			return
		}
	}
	t.Fatalf("none of the queued low-priority jobs was serviced within %d cycles", maxLowWaitCycles)
}

// With both queues busy, high-priority work must keep most cycles.
// This catches a policy that simply favors the low queue.
func TestDispatcherHighPriorityKeepsMajorityShare(t *testing.T) {
	d := NewDispatcher()

	const highBacklog = 500
	const lowBacklog = 50
	const cycles = 100

	for i := 0; i < highBacklog; i++ {
		d.SubmitHighPriority(i)
	}
	for i := 0; i < lowBacklog; i++ {
		d.SubmitLowPriority(i)
	}

	highCompleted, lowCompleted := d.RunDispatchCycles(cycles)

	if highCompleted+lowCompleted != cycles {
		t.Fatalf("expected every one of %d cycles to complete some job, got high=%d low=%d (sum=%d)",
			cycles, highCompleted, lowCompleted, highCompleted+lowCompleted)
	}
	if lowCompleted < 1 {
		t.Fatalf("low-priority job was starved: 0 completions after %d cycles with both queues kept busy", cycles)
	}
	if highCompleted < 2*lowCompleted {
		t.Fatalf("high-priority work didn't keep the majority share: high=%d low=%d over %d cycles (want high >= 2x low)",
			highCompleted, lowCompleted, cycles)
	}
}
