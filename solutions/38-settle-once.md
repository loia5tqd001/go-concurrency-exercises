# Settle Once: CompareAndSwap Between a Timeout and a Completion — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

`Complete` and `Timeout` both guard `notify` with a plain `bool`:

```go
func (r *Responder) Complete(result string) bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("completed: " + result)
	return true
}

func (r *Responder) Timeout() bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("timed out")
	return true
}
```

```
goroutine A (work finishes):  reads settled (false) ──▶ notify("completed") ──▶ settled = true
goroutine B (deadline fires): reads settled (false) ──▶ notify("timed out")  ──▶ settled = true
                                 ↑ both read settled before either wrote it - notify fires TWICE
```

**Verified**: `TestSettleRaceExactlyOneWinner` fails within the first
few dozen rounds (200 simultaneous `Complete`/`Timeout` calls against
one `Responder`, 500 rounds):

```
=== RUN   TestSettleRaceExactlyOneWinner
    check_test.go:116: round 21: notify fired 2 time(s) out of 200 concurrent Complete/Timeout calls, want exactly 1 - a Responder must never settle more than once
--- FAIL: TestSettleRaceExactlyOneWinner (0.00s)
```

`go test --race` doesn't even need the timing to line up — it flags
the raw unsynchronized read/write on `r.settled` outright, on the very
first `Complete`/`Timeout` pair it schedules concurrently, independent
of whether `notify` visibly double-fires that run.

With only *two* real contenders per request (one `Complete`, one
`Timeout`), this bug is much narrower than it looks: a plain `go run`
of `main.go`'s demo will almost always print a clean `0/30`, because
the unsynchronized window is a handful of nanoseconds wide. That's why
the test stresses 200 simultaneous callers per round instead of two —
same underlying bug, opened up statistically until it's reliable to
catch without `-race` at all.

## The fix: a single CompareAndSwap, no retry loop needed

```go
type Responder struct {
	notify  func(outcome string)
	settled int32
}

func (r *Responder) Complete(result string) bool {
	if !atomic.CompareAndSwapInt32(&r.settled, 0, 1) {
		return false
	}
	r.notify("completed: " + result)
	return true
}

func (r *Responder) Timeout() bool {
	if !atomic.CompareAndSwapInt32(&r.settled, 0, 1) {
		return false
	}
	r.notify("timed out")
	return true
}
```

`settled` becomes an `int32` used purely as a two-state flag: `0`
(pending) and `1` (settled). `CompareAndSwapInt32(&r.settled, 0, 1)`
atomically checks "is this still 0?" and, only if so, installs `1` —
in one indivisible step, with no window between the read and the
write for a second caller to slip through. Whichever of `Complete` or
`Timeout` gets there first wins the swap and calls `notify`; the other
sees `settled` already `1`, the swap fails, and it returns `false`
immediately — no lock, no waiting on the winner, no retry loop,
because the state only ever moves one way.

Unlike the flash-sale-style claim this exercise used to be, there's no
retry here: a CAS retry loop exists for when you need to recompute a
*new value* from a value that might have changed underneath you (a
decrement, a running max, a version bump). Here the desired new value
is always the same constant, `1` — if the swap fails, that means
someone else already won, and there is nothing left to retry for.

This is also why `sync.Once` would be the wrong tool despite doing the
"runs exactly once" part correctly: `Once.Do`'s losing path blocks on
an internal mutex until the winner's function returns, which is
precisely backwards for a timeout path whose whole point is to bail
out immediately rather than wait on the winner's `notify` call, however
long that happens to take.

## Test your solution

```
go test
go test --race
```
