# Settle Once: Compare and Swap a Timeout and a Completion — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The problem

`Complete` and `Timeout` both check `notify` with a plain `bool`:

```go {2,5,11,14}
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
few dozen rounds. It runs 200 simultaneous `Complete` and `Timeout`
calls against one `Responder` for 500 rounds.

```
=== RUN   TestSettleRaceExactlyOneWinner
    check_test.go:116: round 21: notify fired 2 time(s) out of 200 concurrent Complete/Timeout calls, want exactly 1 - a Responder must never settle more than once
--- FAIL: TestSettleRaceExactlyOneWinner (0.00s)
```

`go test --race` does not need the timing to line up. It reports the
unsynchronized read and write on `r.settled`. It does this on the first
concurrent `Complete` and `Timeout` pair. It does not matter whether
`notify` visibly fires twice in that run.

The bug is rarer than it looks. Each request has only two real
contenders: one `Complete` and one `Timeout`. A plain `go run` of
`main.go`'s demo will usually print a clean `0/30`. The unsynchronized
window is only nanoseconds wide. The test uses 200 simultaneous callers
per round for this reason. The bug is the same. The test opens it
statistically so it can fail without `-race`.

## The fix: a single CompareAndSwap, no retry loop needed

```go {7,15}
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

`settled` becomes an `int32` used as a two-state flag. `0` means
pending. `1` means settled. `CompareAndSwapInt32(&r.settled, 0, 1)`
checks whether the value is still `0` and installs `1` only if it is.
The check and write happen in one step. No second caller can slip
through between them. The first of `Complete` or `Timeout` wins the
swap and calls `notify`. The other sees `1`, fails the swap, and
returns `false` at once. There is no lock, no wait for the winner, and
no retry loop. The state only moves one way.

Unlike the old flash-sale version, this has no retry. A CAS retry loop
is for computing a new value from one that might change. Examples are a
decrement, a running maximum, or a version bump. Here the new value is
always `1`. A failed swap means another caller already won. There is
nothing to retry.

`sync.Once` would be the wrong tool. It does run the winner once. But
the losing `Once.Do` path waits on an internal mutex until the winner's
function returns. A timeout path must return at once. Waiting on the
winner's `notify` call is the opposite of that.

## Test your solution

```
go test
go test --race
```
