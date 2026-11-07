# Livelock & Starvation

Livelock and starvation are different from deadlock. See
[21-dining-philosophers](../21-dining-philosophers).

- **Livelock** — goroutines stay busy but make no progress. They keep
  reacting to each other in lockstep. A CPU graph can look healthy, which
  hides the problem.
- **Starvation** — overall progress continues. But an unfair policy denies
  service to one participant forever.

## Part 1 — Livelock: `RunLivelockDemo`

```go
func RunLivelockDemo(attempts int) (aProgress, bProgress int)
```

Two workers, A and B, share one resource. Each tries to acquire and
release it up to `attempts` times. Every attempt follows this protocol.
Keep its shape and `probeWindow` value exact. The timing check in
`check_test.go` depends on them:

1. Announce as a contender for this round.
2. Sleep `probeWindow`. Let every contender announce before anyone reads.
3. Snapshot the contender count.
4. Sleep `probeWindow` again. Let every contender read before anyone
   withdraws.
5. Withdraw. Then act on the step-3 snapshot. One contender means a win.
   More than one means a collision. Every colliding worker backs off before
   retrying.

**The bug:** both workers back off for the same fixed time. The collision
repeats forever. Both workers stay busy, but neither makes progress. This
is livelock, not deadlock.

**The fix:** randomize step 5's backoff for each worker. Change nothing
else. Give each worker its own seeded RNG. Do not use one shared global
RNG. The jittered run must stay reproducible.

The naive `go run .` prints no progress for several real seconds. That is
the bug. `check_test.go` uses `testing/synctest`, so tests use no real
wait time.

## Part 2 — Starvation: `Dispatcher`

```go
func NewDispatcher() *Dispatcher
func (d *Dispatcher) SubmitHighPriority(job int)
func (d *Dispatcher) SubmitLowPriority(job int)
func (d *Dispatcher) RunDispatchCycles(n int) (highCompleted, lowCompleted int)
```

`RunDispatchCycles(n)` is the signature. Each call to `RunDispatchCycles`
runs `n` cycles.
Each cycle completes one job queued at that moment. `Submit*` calls may
happen before or between these calls.

**The bug:** the dispatcher uses strict priority. A cycle takes a
high-priority job if one is queued. It looks at low-priority jobs only
when high priority is empty. A high-priority backlog can starve low
priority forever. The dispatcher still does useful work.

**The fix — make it fair:**

- The oldest low-priority job must complete within **10 cycles**. This
  holds for any high-priority backlog. Aging allows this. With several low
  jobs, FIFO order applies on their aging turns.
- When both queues stay busy, high-priority work must take **at least
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
