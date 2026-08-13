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

// TestLivelockBothWorkersMakeProgress fails against the naive fixed-backoff
// version (both workers stay locked at 0 progress) and passes once the
// backoff is independently jittered. Runs under synctest so the fake clock
// resolves every backoff instantly.
//
// The elapsed-time check guards against an implementation that quietly
// drops the required announce/settle protocol (e.g. a bare TryLock loop):
// that protocol costs at least two probeWindow sleeps per attempt even when
// uncontested, so a compliant implementation always burns through a
// predictable minimum of fake time.
func TestLivelockBothWorkersMakeProgress(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const attempts = 50
		const floor = attempts / 4 // generous: neither worker should be anywhere near stuck at zero

		// Comfortably under one probeWindow, but well above what a
		// protocol-less implementation would incur.
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

// TestDispatcherServicesQueuedJobsWhenAvailable is a sanity check,
// independent of the starvation bug: with no high-priority backlog at all,
// low-priority jobs still get serviced normally.
func TestDispatcherServicesQueuedJobsWhenAvailable(t *testing.T) {
	d := NewDispatcher()
	d.SubmitLowPriority(1)
	d.SubmitLowPriority(2)

	highCompleted, lowCompleted := d.RunDispatchCycles(2)

	if highCompleted != 0 || lowCompleted != 2 {
		t.Fatalf("expected 0 high-priority and 2 low-priority completions, got high=%d low=%d", highCompleted, lowCompleted)
	}
}

// maxLowWaitCycles is the README's bounded-wait guarantee: a waiting
// low-priority job must complete within this many cycles, no matter how
// deep the high-priority backlog is.
const maxLowWaitCycles = 10

// TestDispatcherLowPriorityBoundedWait keeps a high-priority backlog deep
// enough that it never empties within maxLowWaitCycles, submits exactly one
// low-priority job, and runs one cycle at a time to find out how long the
// low-priority job actually waits. Fails against the naive strict-priority
// policy, which never services it at all.
func TestDispatcherLowPriorityBoundedWait(t *testing.T) {
	d := NewDispatcher()

	const highBacklog = maxLowWaitCycles * 100 // never drains within the bound
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

// TestDispatcherHighPriorityKeepsMajorityShare checks fairness from the
// other direction: with BOTH queues kept busy for the whole run, high-priority
// work must still take at least two-thirds of completed cycles. This is what
// catches a policy that has simply swapped which queue is favored (e.g.
// draining low first) - such a policy passes the bounded-wait test trivially
// but fails the majority-share check here.
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
