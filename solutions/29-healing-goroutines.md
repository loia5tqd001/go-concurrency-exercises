# Healing Goroutines: Restarting a Wedged Worker - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `29-healing-goroutines/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting `NewSteward` should watch a "ward" goroutine. It should restart the ward if it wedges. A wedged ward hangs, stops pulsing, and stops honoring `done`. `mockward.go`'s `MockWard` simulates this:

```go
func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn {
	return func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
		return ward(done, pulseInterval)
	}
}
```

Keep the exact signature. `NewSteward` returns a `StartGoroutineFn`, so stewards can watch other stewards:

```go
type StartGoroutineFn func(done <-chan struct{}, pulseInterval time.Duration) (heartbeat <-chan struct{})
func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn
```

The returned function receives `(done, pulseInterval)`. It must:

- Start `ward(wardDone, pulseInterval)` with a fresh **steward-owned** `wardDone`.
- Forward each pulse from the current heartbeat to the steward's heartbeat.
- Track time since the last forwarded pulse.
- If `timeout` passes with no pulse, close the current `wardDone`. Do not wait for a wedged ward.
- Start a new generation with a new `wardDone`. Keep forwarding pulses.
- When the steward's `done` closes, close the current `wardDone` and stop.
- Do not send on the steward's heartbeat after `done` closes.

## Why the naive version is wrong

The returned function only passes values through. It gives the ward its own incoming `done`. It also returns the ward's heartbeat directly.

There is no timeout tracking and no restart logic. When the first ward wedges, the returned heartbeat stays silent forever. That is the single point of failure the steward should remove.

An older run showed two of the three failures:

```
=== RUN   TestStewardRestartsWedgedWard
    check_test.go:47: timed out after only 5 pulse(s); an unsupervised ward would already have gone silent for good after 5 pulses (~500ms) - the steward does not appear to be restarting it
--- FAIL: TestStewardRestartsWedgedWard (0.00s)
=== RUN   TestStewardUsesFreshPerGenerationDone
    check_test.go:114: timed out waiting for 3 ward generations to start; only 1 started
--- FAIL: TestStewardUsesFreshPerGenerationDone (0.00s)
=== RUN   TestStewardStopsOnDone
--- PASS: TestStewardStopsOnDone (0.00s)
FAIL
FAIL	github.com/loia5tqd001/go-concurrency-exercises/29-healing-goroutines	0.426s
FAIL
```

`TestStewardRestartsWedgedWard` and `TestStewardUsesFreshPerGenerationDone` fail. The naive code never starts a second generation.

`TestStewardStopsOnDone` passes. It uses a healthy ward with `pulsesBeforeWedge = 1000`. A pass-through steward stops when its `done` closes.

`TestStewardKeepsMonitoringWithoutAReader` also fails. It never starts
the second generation it expects.

`-race` shows the same three clean assertion failures. There is no hang
or panic. `check_test.go` supplies all four tests.

## Approach: one monitoring goroutine, per-generation steward-owned `wardDone`

```go {32,33,98,99}
package main

import (
	"fmt"
	"time"
)

// StartGoroutineFn is the shape shared by every goroutine that can be
// launched, monitored and restarted this way: given a done channel to
// signal it should stop, and how often it should pulse, it starts and
// returns a heartbeat channel that it sends on roughly every
// pulseInterval for as long as it's alive.
type StartGoroutineFn func(done <-chan struct{}, pulseInterval time.Duration) (heartbeat <-chan struct{})

// NewSteward wraps ward with monitoring: it returns a StartGoroutineFn
// with the exact same shape as ward itself, so stewards compose. The
// returned function restarts ward with a fresh generation whenever
// more than timeout elapses without a pulse from the current
// generation.
func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn {
	return func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
		heartbeat := make(chan struct{}, 1)

		go func() {
			defer close(heartbeat)

			// startGeneration starts a brand-new, steward-owned
			// generation of the ward and returns its wardDone (so it
			// can later be closed to ask this generation to stop) and
			// its heartbeat (so pulses can be forwarded).
			startGeneration := func() (wardDone chan struct{}, wardHeartbeat <-chan struct{}) {
				wardDone = make(chan struct{})
				wardHeartbeat = ward(wardDone, pulseInterval)
				return wardDone, wardHeartbeat
			}

			// newTimeout returns a fresh timer channel armed for
			// `timeout` from now. A fresh timer keeps the deadline
			// tied to one generation with no extra mutable timer
			// state to reset or stop.
			newTimeout := func() <-chan time.Time {
				return time.After(timeout)
			}

			wardDone, wardHeartbeat := startGeneration()
			timeoutC := newTimeout()

			for {
				select {
				case <-done:
					// The steward itself is being asked to stop. Best
					// effort: tell the current generation to stop too.
					// A truly wedged ward may never honor this, but
					// closing a channel never blocks, so we don't wait
					// around to find out - we just stop forwarding and
					// return, which (via the defer above) also closes
					// our own heartbeat.
					close(wardDone)
					return

				case _, ok := <-wardHeartbeat:
					if !ok {
						// The current generation's heartbeat channel
						// was closed rather than just going silent.
						// A closed channel is permanently ready to
						// receive, so if we just `continue`d here
						// this case would fire on every single loop
						// iteration - a hot spin that (under
						// synctest) also starves the timeout case of
						// ever winning a select, since a runnable
						// goroutine holds the fake clock back from
						// advancing. Disable the case instead by
						// nilling the channel (receiving from a nil
						// channel blocks forever) and let the timeout
						// path restart the generation.
						wardHeartbeat = nil
						continue
					}

					select {
					case heartbeat <- struct{}{}:
					case <-done:
						close(wardDone)
						return
					default:
						// Coalesce pulses while preserving monitoring.
					}
					timeoutC = newTimeout()

				case <-timeoutC:
					// No pulse from the current generation within
					// timeout: it's presumed wedged. Ask it to stop
					// (best effort, non-blocking - close never
					// blocks) and immediately start a fresh
					// generation, without waiting to see whether the
					// old one ever actually exits.
					close(wardDone)
					wardDone, wardHeartbeat = startGeneration()
					timeoutC = newTimeout()
				}
			}
		}()

		return heartbeat
	}
}

func main() {
	const (
		pulseInterval     = 50 * time.Millisecond
		timeout           = 200 * time.Millisecond
		pulsesBeforeWedge = 4
	)

	ward := NewMockWard(pulsesBeforeWedge)
	steward := NewSteward(timeout, ward.Start)

	done := make(chan struct{})
	heartbeat := steward(done, pulseInterval)

	for i := 1; i <= 10; i++ {
		select {
		case <-heartbeat:
			fmt.Println("pulse", i)
		case <-time.After(pulseInterval * 4):
			fmt.Println("no pulse this round")
		}
	}

	close(done)
	fmt.Println("ward generations started:", ward.Generations())
}
```

`main` is byte-identical to the scaffold. The fix is entirely inside `NewSteward`.

The `"no pulse this round"` message is neutral. The naive code prints it forever after the first wedge. The fixed code prints it only while it replaces a stalled generation. The fixed loop still gets 10 pulses across at least two generations. The final generation count shows the difference.

### Design notes

- **One monitoring goroutine owns all mutable state.** `wardDone`, `wardHeartbeat`, and `timeoutC` are local variables inside one `for`/`select` loop. It shares no state with the caller, so no mutex is needed.
- **Close the old `wardDone` before starting a new generation.** At each loop point, the variables name one live generation. Reassigning `wardHeartbeat` drops the old heartbeat. The steward abandons the old wedged goroutine and does not wait for it.
- **`close(wardDone)` never blocks.** This asks a possibly wedged ward to stop. Closing a channel returns immediately. A send could block forever.
- **Use `time.After` for each generation deadline.** A fresh `time.After(timeout)` needs no stop or `Reset` state. Unlike a reused `time.Timer`, it needs no reuse logic. Go 1.23 removed the stale-value problem after `Timer.Reset`. The module uses Go 1.25.
- **Set `wardHeartbeat = nil` if the ward closes it.** The old code used `ok == false`. A receive from a closed channel succeeds every time. A `continue` would become a hot loop and stop `synctest`'s clock. A nil channel blocks that `select` arm, leaving `timeoutC` active.
- **The old loop could hang under `synctest.Test`.** The test would wait forever instead of failing fast.
- **Do not let heartbeat forwarding stall monitoring.** The one-slot
  buffer and non-blocking send combine pulses when the consumer is slow.
  A blocking send could hide a wedge.
  `TestStewardKeepsMonitoringWithoutAReader` checks this directly.
- **`Dones()` catches a reused `done`.** `MockWard` calls `return` when it wedges. A steward can restart correctly but reuse `done`. `Dones() []<-chan struct{}` records each generation's channel in order. `TestStewardUsesFreshPerGenerationDone` checks that each channel is new.
- **`TestStewardStopsOnDone` catches restarts on a fixed interval.** It reads 40 pulses, or four full `timeout` periods, from a healthy ward. It calls `Generations()` and checks `Generations() == 1`. A steward that resets its time since the last pulse passes. A fixed-interval steward restarts the healthy ward.

### Alternative worth naming: composing `wardDone` with `done` via `or()`

The book's version does not close `wardDone` on the `done` path. It starts each generation with `or(wardDone, done)`. This "or-done channel" closes when either input closes. The steward's `done` therefore stops the current generation.

This exercise requires the steward to close `wardDone` itself. This solution follows that rule.

Both versions behave the same for a direct steward. The `or()` version also cleans up composed stewards. It needs readers to know the `or()` pattern.

## Verified

The naive `main.go` fails three tests: `TestStewardRestartsWedgedWard`,
`TestStewardUsesFreshPerGenerationDone`, and
`TestStewardKeepsMonitoringWithoutAReader`. `TestStewardStopsOnDone`
passes because it never wedges. Use `go test -v ./...` or
`go test -race -v ./...` to see this.

The scratch module has `go.mod` pinned to `go 1.25.6`. `go build ./...`,
`go vet ./...`, and `gofmt -l .` are clean. The
`go test -race -count=5` run passes all four tests every time.

An earlier `continue`-only version kept using CPU in a tight loop on a closed `wardHeartbeat`. `MockWard` does not test that case. The `go test -race -count=5` repetition alone did not catch it. After setting the channel to nil, `go test -race -count=20 ./...` passed 20 times. The full `go test -race -count=5 ./...` run also passed after the fix.

Two wrong variants confirmed the tests. Reusing the caller's `done` fails only `TestStewardUsesFreshPerGenerationDone`. A `time.Ticker` on `timeout` that never resets fails only `TestStewardStopsOnDone`.

`go run .` also printed pulses after the first wedge. It ended with a `ward generations started:` count above one. The exact count changes with real-clock timing, usually 2 to 3.

The real `29-healing-goroutines/main.go` stayed unchanged. All fix iterations used a scratch copy.
