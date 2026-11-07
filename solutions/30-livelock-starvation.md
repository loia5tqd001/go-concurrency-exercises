# Livelock and Starvation - Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The bug, and the fix

**Livelock.** Both workers use the same fixed `10ms` backoff after a collision. The announce/settle protocol keeps their rounds aligned. They collide again every round.

The fix uses a seeded `*rand.Rand` per worker for independent jitter. Do not use one shared source. A fixed seed keeps the run reproducible.

**Starvation.** `RunDispatchCycles` always drains high priority first. A high-priority backlog that never empties therefore blocks low priority forever.

The fix uses weighted round-robin. Every `agingPeriod` cycles, it serves one waiting low-priority job. Check this before the high-priority branch. Checking after would make it unreachable.

`check_test.go` checks both the livelock fix and the fairness policy.

```go {36,37,41,42,79,81}
package main

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

const probeWindow = 1 * time.Millisecond
const baseBackoff = 10 * time.Millisecond
const jitterSpan = 10 * time.Millisecond
const retryBudgetMultiplier = 200

func RunLivelockDemo(attempts int) (aProgress, bProgress int) {
	var contenders int32
	totalRetryBudget := int64(attempts) * retryBudgetMultiplier
	var totalRetries int64

	run := func(succeeded *int, rng *rand.Rand) {
		for *succeeded < attempts {
			if atomic.AddInt64(&totalRetries, 1) > totalRetryBudget {
				return
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
			jitter := time.Duration(rng.Int63n(int64(jitterSpan)))
			time.Sleep(baseBackoff + jitter)
		}
	}

	randA := rand.New(rand.NewSource(1))
	randB := rand.New(rand.NewSource(2))

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); run(&aProgress, randA) }()
	go func() { defer wg.Done(); run(&bProgress, randB) }()
	wg.Wait()
	return
}

const agingPeriod = 5

type Dispatcher struct {
	mu    sync.Mutex
	high  []int
	low   []int
	cycle int
}

func NewDispatcher() *Dispatcher { return &Dispatcher{} }

func (d *Dispatcher) SubmitHighPriority(job int) {
	d.mu.Lock()
	d.high = append(d.high, job)
	d.mu.Unlock()
}

func (d *Dispatcher) SubmitLowPriority(job int) {
	d.mu.Lock()
	d.low = append(d.low, job)
	d.mu.Unlock()
}

func (d *Dispatcher) RunDispatchCycles(n int) (highCompleted, lowCompleted int) {
	for i := 0; i < n; i++ {
		d.mu.Lock()
		d.cycle++
		lowIsAgingTurn := d.cycle%agingPeriod == 0

		if lowIsAgingTurn && len(d.low) > 0 {
			d.low = d.low[1:]
			d.mu.Unlock()
			lowCompleted++
			continue
		}
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
```

## Why this works

- **The livelock fix changes one source, not the protocol.** Only step 5's backoff changes. Use per-worker jitter instead of one fixed duration.
- **Keep the announce/settle protocol.** A bare `TryLock` loop or blocking `Mutex` would pass the progress test without real contention. The minimum elapsed-time check catches that.
- **Use per-worker seeded RNGs.** If workers meet again, their next delays should differ. Fixed seeds also keep `synctest` runs reproducible.
- **`agingPeriod = 5` gives a fixed wait bound.** A waiting low-priority job runs within `agingPeriod` cycles after reaching the queue head. The aging check runs before the high-priority check.
- **Periods from 3 to 10 pass both guarantees.** `agingPeriod=2` gives a 50/50 share and fails the two-thirds test. `agingPeriod=11+` misses the 10-cycle bound.
- **Two starvation tests catch different bugs.** Draining low first passes bounded wait but fails majority share. Keep both tests.

## Key takeaways

- Deadlock means blocked and idle. Livelock means busy but making no progress. Starvation means the system progresses while one participant waits forever.
- All three problems can look the same on an availability dashboard.
- A retry with the same delay can recreate a livelock. Use jitter that differs between contenders.
- A progress-floor test can pass a broken timing fix. Also check the minimum elapsed time.
- A fairness policy needs a worst-case bound. Test both bounded wait and majority share.

**Verified:** The naive `main.go` fails `TestLivelockBothWorkersMakeProgress`, `TestDispatcherLowPriorityBoundedWait`, and `TestDispatcherHighPriorityKeepsMajorityShare`. It passes only the no-backlog sanity check. The fix is `gofmt`/`vet` clean and passes `go test -race -count=5` every time.
