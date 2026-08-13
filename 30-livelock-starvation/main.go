// This file has two independent, deliberately-broken pieces - livelock and
// starvation - see README.md for the problem statement and required fixes.

package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// probeWindow is how long a worker waits, twice per round, for every other
// contender to announce and be read before anyone withdraws. Required
// scaffolding (see README.md) - keep both its use and this exact value.
const probeWindow = 1 * time.Millisecond

// fixedBackoff is the delay a worker sleeps out after losing contention.
// It's identical for both workers and has no randomness - that's the bug
// (see README.md): it makes every collision reproduce forever.
const fixedBackoff = 10 * time.Millisecond

// retryBudgetMultiplier bounds the worst case so this naive version still
// returns eventually instead of spinning forever. Scaffolding, not the fix.
const retryBudgetMultiplier = 200

// RunLivelockDemo runs two workers, A and B, each attempting to acquire and
// immediately release one shared resource up to attempts times. It returns
// how many times each worker actually succeeded before both finished (or the
// retry budget ran out).
func RunLivelockDemo(attempts int) (aProgress, bProgress int) {
	var contenders int32 // how many workers want the resource this round

	totalRetryBudget := int64(attempts) * retryBudgetMultiplier
	var totalRetries int64

	run := func(succeeded *int) {
		for *succeeded < attempts {
			if atomic.AddInt64(&totalRetries, 1) > totalRetryBudget {
				return // escape hatch: the demo itself must not hang
			}

			atomic.AddInt32(&contenders, 1) // 1: announce
			time.Sleep(probeWindow)         // 2: settle

			n := atomic.LoadInt32(&contenders) // 3: read
			time.Sleep(probeWindow)            // 4: settle again

			atomic.AddInt32(&contenders, -1) // 5: withdraw

			if n == 1 {
				*succeeded++ // sole contender: uncontested win
				continue
			}

			// Collision: both workers back off for the identical fixed
			// duration, so they wake at the same instant and collide
			// again next round - the lockstep never breaks on its own.
			time.Sleep(fixedBackoff)
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); run(&aProgress) }()
	go func() { defer wg.Done(); run(&bProgress) }()
	wg.Wait()

	return
}

// Dispatcher runs queued jobs in dispatch cycles. In its current, naive form
// it is strict, never-aging priority: see README.md for the bug and the
// fairness policy required to fix it.
type Dispatcher struct {
	mu   sync.Mutex
	high []int
	low  []int
}

// NewDispatcher creates an empty Dispatcher.
func NewDispatcher() *Dispatcher {
	return &Dispatcher{}
}

// SubmitHighPriority enqueues job onto the high-priority queue.
func (d *Dispatcher) SubmitHighPriority(job int) {
	d.mu.Lock()
	d.high = append(d.high, job)
	d.mu.Unlock()
}

// SubmitLowPriority enqueues job onto the low-priority queue.
func (d *Dispatcher) SubmitLowPriority(job int) {
	d.mu.Lock()
	d.low = append(d.low, job)
	d.mu.Unlock()
}

// RunDispatchCycles runs n dispatch cycles. Each cycle picks exactly one
// currently-queued job to run to completion, recording it in highCompleted
// or lowCompleted depending on which queue it came from.
func (d *Dispatcher) RunDispatchCycles(n int) (highCompleted, lowCompleted int) {
	for i := 0; i < n; i++ {
		d.mu.Lock()

		// BUG: high always wins if non-empty, with no regard for how long
		// a low-priority job has been waiting (see README.md).
		if len(d.high) > 0 {
			d.high = d.high[1:]
			d.mu.Unlock()
			highCompleted++
			continue
		}

		if len(d.low) > 0 {
			d.low = d.low[1:]
			d.mu.Unlock()
			lowCompleted++
			continue
		}

		d.mu.Unlock() // nothing queued this cycle
	}

	return
}

func main() {
	// This call will churn for several real seconds, printing zero progress
	// for both workers, because of the missing-jitter bug - that's the point.
	// The graded artifact is check_test.go, which uses testing/synctest so it
	// costs no real wall-clock time.
	aProgress, bProgress := RunLivelockDemo(5)
	fmt.Printf("livelock demo: a=%d b=%d (both stuck near zero is the bug)\n", aProgress, bProgress)

	d := NewDispatcher()
	for i := 0; i < 20; i++ {
		d.SubmitHighPriority(i)
	}
	d.SubmitLowPriority(1)

	highCompleted, lowCompleted := d.RunDispatchCycles(10)
	fmt.Printf("dispatcher demo: high=%d low=%d (low stuck at zero is the bug)\n", highCompleted, lowCompleted)
}
