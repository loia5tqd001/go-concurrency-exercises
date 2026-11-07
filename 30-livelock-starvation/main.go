// This file has two broken demos: livelock and starvation.
// See README.md for the required fixes.

package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Each worker waits twice for other workers to announce and withdraw.
// Keep this value and its use; the exercise requires them.
const probeWindow = 1 * time.Millisecond

// Both workers use this delay after losing.
// The fixed delay keeps them in lockstep and causes the livelock.
const fixedBackoff = 10 * time.Millisecond

// This cap keeps the broken demo from running forever.
// It is scaffolding, not the fix.
const retryBudgetMultiplier = 200

// RunLivelockDemo runs two workers against one shared resource.
// It returns how many times each worker succeeded.
func RunLivelockDemo(attempts int) (aProgress, bProgress int) {
	var contenders int32 // Workers trying to use the resource this round.

	totalRetryBudget := int64(attempts) * retryBudgetMultiplier
	var totalRetries int64

	run := func(succeeded *int) {
		for *succeeded < attempts {
			if atomic.AddInt64(&totalRetries, 1) > totalRetryBudget {
				return // Keep the broken demo from hanging.
			}

			atomic.AddInt32(&contenders, 1)
			time.Sleep(probeWindow)

			n := atomic.LoadInt32(&contenders)
			time.Sleep(probeWindow)

			atomic.AddInt32(&contenders, -1)

			if n == 1 {
				*succeeded++
				continue
			}

			// Both workers wake together and collide again.
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

// Dispatcher runs queued jobs in cycles.
// It currently uses strict priority, so low-priority jobs can starve.
type Dispatcher struct {
	mu   sync.Mutex
	high []int
	low  []int
}

// NewDispatcher returns an empty Dispatcher.
func NewDispatcher() *Dispatcher {
	return &Dispatcher{}
}

// SubmitHighPriority adds job to the high-priority queue.
func (d *Dispatcher) SubmitHighPriority(job int) {
	d.mu.Lock()
	d.high = append(d.high, job)
	d.mu.Unlock()
}

// SubmitLowPriority adds job to the low-priority queue.
func (d *Dispatcher) SubmitLowPriority(job int) {
	d.mu.Lock()
	d.low = append(d.low, job)
	d.mu.Unlock()
}

// RunDispatchCycles runs n cycles.
// Each cycle completes one queued job.
func (d *Dispatcher) RunDispatchCycles(n int) (highCompleted, lowCompleted int) {
	for i := 0; i < n; i++ {
		d.mu.Lock()

		// BUG: High priority always wins, even when a low job is old.
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

		d.mu.Unlock()
	}

	return
}

func main() {
	// This demo prints little or no progress because of the livelock.
	// The test uses synctest, so it does not wait in real time.
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
