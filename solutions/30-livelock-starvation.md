# Livelock & Starvation - Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The bug, and the fix

**Livelock.** Both workers back off for the identical fixed `10ms` on
collision, and the announce/settle protocol keeps their rounds aligned, so a
collision reproduces every round forever. Fix: jitter the backoff
independently per worker, using a seeded `*rand.Rand` per worker (not a
shared/global source) so the run stays reproducible.

**Starvation.** `RunDispatchCycles` drains high-priority first, full stop,
so a non-emptying high backlog starves low-priority forever. Fix: weighted
round-robin — reserve every `agingPeriod`-th cycle for a waiting
low-priority job, checked *before* the high-priority branch (checking it
after would make it just as unreachable as the original bug).

```go
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

- **Livelock fix is a one-line change in kind, not degree**: only step 5's
  backoff source changes (shared fixed duration → per-worker jittered). The
  announce/settle protocol itself is required scaffolding, not something to
  simplify away — a bare `TryLock` loop or plain blocking `Mutex` would
  trivially clear the progress-floor check without ever exercising real
  contention, which is exactly what `check_test.go`'s minimum-elapsed-time
  check is there to catch.
- **Per-worker seeded RNGs, not a shared global source**: two things ride on
  this. First, if the workers do land on the same round again, their next
  jittered delays have no reason to re-align, so any repeat collision is a
  one-off, not a new lockstep. Second, fixed seeds keep the demo
  deterministic and reproducible under `synctest`'s fake clock.
- **`agingPeriod = 5` bounds the wait exactly**: any waiting low-priority
  job is serviced within `agingPeriod` cycles of reaching the head of its
  queue, regardless of backlog depth, because the aging check runs
  unconditionally *before* the high-priority check. Any period from 3 to 10
  keeps both guarantees `check_test.go` checks satisfied (`agingPeriod=2`
  fails the two-thirds share at 50/50; `agingPeriod=11+` misses the
  10-cycle bound) - smaller favors fairness, larger favors high-priority
  throughput.
- **Two starvation tests catch different failure modes**: a policy that
  simply inverts priority (drains low first) passes the bounded-wait test
  trivially but fails the majority-share test — that's why both exist.

## Key takeaways

- Deadlock: stuck, blocked, doing nothing. Livelock: busy, executing,
  still making zero net progress because actions keep canceling each other
  out. Starvation: system-wide progress is fine, one participant's requests
  are never selected. All three look identical on a "is anything crashing?"
  dashboard.
- Backoff-and-retry isn't automatically a livelock fix — it reproduces the
  livelock if every retrier uses the same deterministic delay. The fix is
  jitter whose *timing isn't shared* across contenders, not just "some
  randomness somewhere."
- A progress-floor test alone can pass on implementations that fix nothing,
  if the property being tested is about timing and the test doesn't force
  the timing conditions that expose it — pair it with a minimum-elapsed-time
  check grounded in the protocol's mandatory cost.
- A fairness policy needs a provable worst-case bound, not just "check the
  other queue sometimes" — and needs to be tested from both directions
  (bounded wait *and* majority share), since a naive fix can satisfy one by
  simply starving the other queue instead.

**Verified**: naive `main.go` fails `TestLivelockBothWorkersMakeProgress`,
`TestDispatcherLowPriorityBoundedWait`, `TestDispatcherHighPriorityKeepsMajorityShare`
(passes only the no-backlog sanity check). The fix above is `gofmt`/`vet`
clean and passes `go test -race -count=5` with no flakes.
