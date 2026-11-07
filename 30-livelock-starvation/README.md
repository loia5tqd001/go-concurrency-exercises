# Livelock & Starvation

Two failure modes distinct from deadlock (see [21-dining-philosophers](../21-dining-philosophers)):

- **Livelock** — goroutines stay busy but make no progress: they keep reacting to
  each other in lockstep. Looks healthy on a CPU graph, which is what makes it
  sneaky.
- **Starvation** — the system makes steady progress overall, but one participant
  is perpetually denied service by an unfair policy.

## Part 1 — Livelock: `RunLivelockDemo`

```go
func RunLivelockDemo(attempts int) (aProgress, bProgress int)
```

Two workers, A and B, each try to acquire-and-release one shared resource up to
`attempts` times. Every attempt runs this protocol — **keep its shape and the
`probeWindow` value exactly; `check_test.go`'s timing check is calibrated
against it**:

1. Announce as a contender for this round.
2. Sleep `probeWindow` (let every contender announce before anyone reads).
3. Snapshot the contender count.
4. Sleep `probeWindow` again (let every contender read before anyone withdraws).
5. Withdraw, then act on the step-3 snapshot: exactly one contender = win; more
   than one = collision, and every colliding worker backs off before retrying.

**The bug:** both workers back off for the *same fixed duration*, so a
collision reproduces forever — a perfect, self-sustaining lockstep, even
though both workers stay constantly busy (that's the "livelock," as opposed
to deadlock, distinction).

**The fix:** make step 5's backoff *independently randomized per worker*.
Nothing else changes. Give each worker its own seeded RNG (not a shared
global one) so the jittered run stays reproducible.

(Running `go run .` against the naive version will visibly churn for
several real seconds, printing no progress for either worker, before
giving up - that's the bug. `check_test.go` uses `testing/synctest` so it
costs no real wall-clock time.)

## Part 2 — Starvation: `Dispatcher`

```go
func NewDispatcher() *Dispatcher
func (d *Dispatcher) SubmitHighPriority(job int)
func (d *Dispatcher) SubmitLowPriority(job int)
func (d *Dispatcher) RunDispatchCycles(n int) (highCompleted, lowCompleted int)
```

Each call to `RunDispatchCycles(n)` runs `n` cycles; each cycle completes
exactly one job that's queued *at that instant* (`Submit*` calls may happen
before or between calls to `RunDispatchCycles`).

**The bug:** strict priority — a cycle drains a high-priority job if one is
queued, full stop, and only looks at low-priority once high is completely
empty. A high-priority backlog that never runs dry starves low-priority work
forever, even though the dispatcher is always doing useful work.

**The fix — make it fair:**

- A waiting low-priority job must complete within **10 cycles**, no matter how
  deep the high-priority backlog is (aging).
- When both queues stay busy, high-priority work must still take **at least
  two-thirds** of completed cycles.

```
PART 1 - LIVELOCK  (2 goroutines, probeWindow 1ms, twice per round)

  today (broken)                        goal (per-worker seeded RNG)
  A ──▶ read=2 ──▶ sleep 10ms           A ──▶ read=2 ──▶ sleep 10ms+randA
  B ──▶ read=2 ──▶ sleep 10ms           B ──▶ read=2 ──▶ sleep 10ms+randB
                 │                                     │
                 ▼                                     ▼
      wake together, collide again      wakes drift apart,
      forever: a=0  b=0  (still busy)   progress: a=5  b=5  (5 attempts)

PART 2 - STARVATION  (20 high queued, 1 low, 10 cycles)

  today (broken)                        goal (aging every 5th cycle)
  high non-empty ──▶ take high          cycle 5      ──▶ take low
  high empty     ──▶ take low           other cycles ──▶ take high
                   │                                   │
                   ▼                                   ▼
      high=10  low=0  (low starved)     high=9  low=1  (low waited 5 cycles)
      backlog 1000: low never runs      backlog 1000: low within 10 cycles
                                        both busy: high 4/5 = 80% >= 2/3
```

## Test your solution

```
go test
go test --race
```
