# Heartbeats: Detecting a Stalled Worker - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `27-heartbeats/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting code has `DoWork`, a simulated long-running worker. It also has `WorkWithTimeout`. `WorkWithTimeout` should use `DoWork`'s heartbeat to detect a stall quickly:

```go
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int)
func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error)
```

`DoWork` must process `workUnits` one at a time. See `mockworker.go`'s `SimulateUnit`. It sends one result per unit and closes `results` when done.

`DoWork` must also pulse on `heartbeat` about every `pulseInterval` while a unit is active. The pulse separates "slow but working" from "stuck forever." A caller waiting only for a result cannot tell them apart.

`WorkWithTimeout` must run `DoWork`. It must reset a timer to `perPulseTimeout` on every heartbeat or result. If neither arrives before the timer fires, it must return a non-nil error. It should detect a stall within about one `perPulseTimeout` window.

`stallAfter` is a `WorkWithTimeout` parameter. It selects a unit index for a simulated stall through `mockworker.go`'s `SetStallUnit`. A negative or out-of-range value runs normally.

## Why the naive version is wrong

```go {14}
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int) {
	hb := make(chan struct{}, 1) // buffered so the lone startup pulse below can complete even though nobody ever reads it
	res := make(chan int)

	go func() {
		defer close(res)

		select {
		case hb <- struct{}{}: // one pulse, ever, right at startup
		case <-done:
			return
		}

		checkIn := func() bool { return true } // BUG: never actually sends a heartbeat

		for i := 0; i < workUnits; i++ {
			if !SimulateUnit(done, i, pulseInterval, checkIn) {
				return
			}
			select {
			case res <- i:
			case <-done:
				return
			}
		}
	}()

	return hb, res
}
```

`DoWork` sends one heartbeat at startup. The `checkIn` callback returns `true`, but it never sends a pulse. `WorkWithTimeout` also never reads `heartbeat`.

Instead of resetting a timer, `WorkWithTimeout` sets one flat deadline: `perPulseTimeout * workUnits`. It never changes that deadline:

```go {1}
timedOut := time.After(perPulseTimeout * time.Duration(workUnits))
for {
	select {
	case r, ok := <-results:
		...
	case <-timedOut:
		return nil, fmt.Errorf("work timed out after %s", ...)
	}
}
```

One flat deadline cannot pass both timing tests:

- `TestNoStallCompletesSuccessfully` needs a deadline longer than `UnitDuration(400ms) * workUnits(5) = 2000ms`.
- `TestStallDetectedPromptly` needs a deadline no later than `stallStartsAt(800ms) + perPulseTimeout(300ms) + slack ≈ 1300ms`.

The naive deadline is `perPulseTimeout(300ms) * workUnits(5) = 1500ms`. It is too short for the first test and too long for the second. Only a timer that resets on activity can pass both.

Verified with the `go1.25.6` toolchain. Set `GOROOT` to that toolchain. `go test -race -timeout 30s -v ./...` fails all three tests against the naive `main.go`:

```
=== RUN   TestNoStallCompletesSuccessfully
    check_test.go:33: expected nil error for a normal run, got work timed out after 1.5s
--- FAIL: TestNoStallCompletesSuccessfully (0.00s)
=== RUN   TestStallDetectedPromptly
    check_test.go:89: did not detect the stall promptly: took 1.5s, want at most 1.3s (stall starts at 800ms + one perPulseTimeout of 300ms)
--- FAIL: TestStallDetectedPromptly (0.00s)
=== RUN   TestConcurrentSafety
    check_test.go:129: caller 0: work timed out after 900ms
    check_test.go:129: caller 1: work timed out after 900ms
    check_test.go:129: caller 2: work timed out after 900ms
    ... (all 20 callers fail identically)
    check_test.go:129: caller 19: work timed out after 900ms
--- FAIL: TestConcurrentSafety (0.90s)
FAIL
FAIL	github.com/loia5tqd001/go-concurrency-exercises/27-heartbeats	1.035s
```

`TestConcurrentSafety` uses `workUnits = 3`. Its flat deadline is `300ms * 3 = 900ms`. The healthy job takes `3 * 400ms = 1200ms`. The test therefore times out even without a stall.

All three failures have the same cause. They fail cleanly, with no hang, `synctest` panic, or race report.

## The fix

```go {37-44,93,100}
package main

import (
	"fmt"
	"time"
)

// workerPulseInterval is the fixed interval WorkWithTimeout asks
// DoWork to pulse at. It must stay shorter than any perPulseTimeout a
// caller passes in, or every call would time out before a single
// heartbeat could possibly arrive.
const workerPulseInterval = 100 * time.Millisecond

// DoWork simulates doing workUnits units of work, one at a time,
// sending one result int per completed unit on results and closing
// results when the whole job is done (or done fires early). While it
// is actively working on a unit, it also pulses on heartbeat roughly
// every pulseInterval, for as long as that unit takes.
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int) {
	hb := make(chan struct{})
	res := make(chan int)

	go func() {
		defer close(res)

		// checkIn is SimulateUnit's "still working, got a moment to
		// report in?" callback. Every time a healthy unit calls it
		// (between pulseInterval-sized slices of its work), we try to
		// send one pulse on hb - that's what makes the heartbeat track
		// genuine progress instead of firing on a schedule of its own.
		// A stalled unit never calls checkIn at all, so hb simply goes
		// quiet for as long as the stall lasts.
		//
		// The send itself also has to respect done: if nobody is
		// listening (the caller gave up) we must not block forever on
		// a send nobody will ever receive.
		checkIn := func() bool {
			select {
			case hb <- struct{}{}:
				return true
			case <-done:
				return false
			}
		}

		for i := 0; i < workUnits; i++ {
			if !SimulateUnit(done, i, pulseInterval, checkIn) {
				return
			}

			select {
			case res <- i:
			case <-done:
				return
			}
		}
	}()

	return hb, res
}

// WorkWithTimeout runs DoWork to completion and fails fast - within
// roughly one perPulseTimeout window - the moment the worker stops
// pulsing AND stops producing results, instead of waiting for however
// long the stalled unit would otherwise have taken.
func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error) {
	SetStallUnit(stallAfter)

	done := make(chan struct{})
	defer close(done)

	heartbeat, results := DoWork(done, workerPulseInterval, workUnits)

	collected := make([]int, 0, workUnits)

	// The stall timer is reset to perPulseTimeout every time a
	// heartbeat OR a result arrives - it only ever gets to fire if
	// BOTH channels have gone silent for a full perPulseTimeout, which
	// is exactly the definition of "stalled" we care about.
	//
	// go.mod pins this module to Go 1.25.6. As of Go 1.23, a chan-based
	// time.Timer's Reset can be called directly on a running timer: any
	// receive from t.C after Reset returns is guaranteed not to observe
	// a stale value from the previous duration, so there is no need for
	// the older Stop-then-drain-then-Reset dance that earlier Go
	// versions required.
	timer := time.NewTimer(perPulseTimeout)
	defer timer.Stop()

	for {
		select {
		case <-heartbeat:
			timer.Reset(perPulseTimeout)

		case r, ok := <-results:
			if !ok {
				return collected, nil
			}
			collected = append(collected, r)
			timer.Reset(perPulseTimeout)

		case <-timer.C:
			return nil, fmt.Errorf("worker stalled: no heartbeat or result within %s", perPulseTimeout)
		}
	}
}
```

Design notes:

- **Tie the pulse to real work progress.** `SimulateUnit` calls `checkIn` between a healthy unit's small time slices. The stalled path never calls `checkIn`.
- A `checkIn` result of `false` stops a healthy unit early.
- **Do not use an independent `time.Ticker` for the pulse.** It would keep sending even when the unit is stuck. The caller could never detect a stall.
- **Use an unbuffered `hb`.** A heartbeat then means a receiver got the pulse immediately. This is a real liveness signal. The naive code needs a capacity-1 buffer only for its one startup pulse.
- **Use `select` with `<-done` for every send.** `WorkWithTimeout` puts `defer` before `close(done)` on every return path. The worker may still be active. A blocked heartbeat or `res <- i` send would leak the worker.
- **Receive `heartbeat` as `case <-heartbeat:`.** `DoWork` never closes `heartbeat`. Only `results` gets `defer close`. The test suite also avoids `v, ok := <-heartbeat` and a `!ok` branch.
- **Reset one shared timer on every heartbeat or result.** Use `Timer.Reset` on each activity. A healthy job resets it about every `workerPulseInterval`. A stalled unit stops resetting it.
- **The timer fires about `perPulseTimeout` after the last event.** The exact call is `timer.Reset(perPulseTimeout)`.
- **`Timer.Reset` is safe in Go 1.25.6.** Before Go 1.23, a fired timer needed `Stop` and a drain. In this version, `Reset` removes old values from `timer.C`.
- The repo's `go.mod` selects Go 1.25.6.
- **Keep work and watching in separate goroutines.** They communicate only through channels. The watcher only needs to know that pulses stopped, not why.

**Verified:** `go build ./...`, `go vet ./...`, and `gofmt -l .` are clean. `go test -race -count=5 -v ./...` runs all three tests five times. They passed every time:

```
=== RUN   TestNoStallCompletesSuccessfully
--- PASS: TestNoStallCompletesSuccessfully (0.00s)
=== RUN   TestStallDetectedPromptly
--- PASS: TestStallDetectedPromptly (0.00s)
=== RUN   TestConcurrentSafety
--- PASS: TestConcurrentSafety (1.21s)
... (repeated identically 4 more times)
PASS
ok  	scratch27heartbeats	7.749s
```

`TestNoStallCompletesSuccessfully` and `TestStallDetectedPromptly` use `synctest.Test`. Their `(0.00s)` times are real. The simulated 2s and 1.1s runs cost no wall-clock time.

`TestConcurrentSafety` runs 20 callers under `-race`. It takes about 1.2s. This matches `workUnits=3 * UnitDuration=400ms` running mostly in parallel.

Here is the timing math for `TestStallDetectedPromptly`. `UnitDuration=400ms`, `stallAfter=2`, and `testPerPulseTimeout=300ms`. The stall starts at `2*400ms = 800ms`. The last reset is the result for unit 1 at `800ms`. The correct code times out at `800ms + 300ms = 1.1s`.

The test bound is `stallStartsAt + perPulseTimeout + 2*workerPulseInterval = 1.3s`. The healthy run takes about `2s`. The stalled unit uses a `24h` `StallDuration`.

The naive flat deadline is `perPulseTimeout*workUnits = 1.5s`. It is above the 1.3s stall bound, so `TestStallDetectedPromptly` fails. It is below the 2s healthy run, so `TestNoStallCompletesSuccessfully` also fails.

The real `27-heartbeats/main.go` stayed unchanged during verification. Only the scratch copy received the fix.

## Alternative approach: a fresh `time.After` per iteration instead of one reused timer

The main fix uses one `time.Timer` before the loop. It calls `Reset` from both activity branches.

A simpler alternative creates a fresh `time.After` each time the `select` runs:

```go {11}
for {
	select {
	case <-heartbeat:
		// no reset call needed - looping back into select below
		// re-evaluates time.After(perPulseTimeout) from this instant
	case r, ok := <-results:
		if !ok {
			return collected, nil
		}
		collected = append(collected, r)
	case <-time.After(perPulseTimeout):
		return nil, fmt.Errorf("worker stalled: no heartbeat or result within %s", perPulseTimeout)
	}
}
```

This version is correct and easier to read. It has no `Reset` call on two branches. It also avoids the Go 1.23 timer change. It creates a new timer each time.

`go doc time.After` says:

> Before Go 1.23, an unreferenced timer was not recovered before it fired.
> Go 1.23 can recover unreferenced, unstopped timers.
> Prefer `After` when it fits.

The module uses `go 1.25.6`, so a `time.After` per loop does not leak. The garbage collector can reclaim the unused timer.

The remaining difference is allocation. `timer.Reset` reuses one `runtime.timer`. `time.After` creates a timer for every heartbeat and result. The guide says `NewTimer` is not needed when `After` fits.

One call does not care. Many long-lived watchers do. Use the reused, `Reset`-based timer for hot paths.

## Key takeaways

- A heartbeat must come from real work progress. A fixed ticker keeps firing when the worker is stuck.
- Reset one timer on a heartbeat or a result. Treat that timer as the only stall signal.
- A whole-job deadline confuses a long job with a stuck job. One value usually cannot fit both cases.
- Give every blocking send and receive a `done` exit path. Use `select`.
- Go 1.23 changed the safe use of `time.Timer.Reset`. Check the module's Go version first.
