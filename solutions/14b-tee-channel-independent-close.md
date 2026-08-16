# Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `14b-tee-channel-independent-close/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

This exercise picks up where [14](../14-tee-channel) left off. The given starting point is already a complete, correct answer to 14 itself:

```go
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	out1 := make(chan int)
	out2 := make(chan int)

	go func() {
		defer close(out1)
		defer close(out2)

		for {
			var v int
			var ok bool

			select {
			case <-done:
				return
			case v, ok = <-in:
				if !ok {
					return
				}
			}

			out1Ch, out2Ch := out1, out2
			for out1Ch != nil || out2Ch != nil {
				select {
				case out1Ch <- v:
					out1Ch = nil
				case out2Ch <- v:
					out2Ch = nil
				case <-done:
					return
				}
			}
		}
	}()

	return out1, out2
}
```

For each value, an inner `select` races both sends, nilling out whichever local channel variable has already received the current value (a nil channel is never selectable, so it drops out of the `select` for good) — so writing to one output never has to happen strictly before the other. `done` is checked in both the outer receive loop and the inner send loop, so shutdown is prompt either way. None of this needs fixing.

What's missing: closing is gated on the **slowest** consumer. The single goroutine above holds value N until *both* `out1Ch` and `out2Ch` have gone nil (i.e., both outputs received it) before it even looks at value N+1, and only closes both channels together, once, after the loop returns. If one consumer has already received every value the sensor will ever produce but the other hasn't read anything, the fast consumer's channel still won't close — the goroutine is stuck trying to hand still-pending values to the untouched side first.

`check_test.go` (identical to 14's, plus one additional test) checks this directly: `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` drains one output *completely* while the other is never read, then asserts the drained one is already closed. It runs in both directions (`out1` fast/`out2` slow, and vice versa) so an implementation that special-cases index 0 can't sneak by either.

## Why the given starting code isn't enough

Verified against the given `main.go` in a throwaway scratch copy: `TestTeeDuplicatesToBothConsumers(ReversedRoles)`, `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther`, and `TestTeeStopsOnDone(Race)` all pass — this code is a genuinely correct answer to 14's requirements, including the "no fixed try-order" property, since the inner `select` really does race both sends rather than attempting them in sequence.

`TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` fails, and for a structural reason, not a closing-logic bug per se:

```
--- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out1_is_the_fast_one (0.00s)
    check_test.go:308: no value received within 20ms - is delivery to this output waiting on some other output being read first?
panic: deadlock: main bubble goroutine has exited but blocked goroutines remain
```

The test's second `receiveWithTimeout` call on the fast output already times out: the delivery goroutine is still parked trying to hand value 0 to the untouched slow side and hasn't even looked at value 1 yet. "Holding each value until both outputs receive it, one value at a time, in a single goroutine" is exactly what 14 asked for — and it's precisely why this design can never let one output run more than a fraction of a value ahead of a completely unread other, no matter how the closing code is written on top of it. (The secondary deadlock panic is a separate, structural side effect of combining `synctest` with `StartSensor`'s cancellation-blind mock and an early `t.Fatalf` — it happens for any implementation that genuinely blocks here, not something specific to this code.)

So fixing this needs more than moving the `close` calls around — it needs abandoning the single-goroutine, hold-until-both-received-it model in favor of letting each output's delivery progress independently.

## The fix: per-output completion tracking, independent closers

```go
package main

import (
	"fmt"
	"sync"
)

// orDone adapts a channel so ranging over it also stops when done
// fires, not just when the channel closes.
func orDone[T any](done <-chan struct{}, c <-chan T) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for {
			select {
			case <-done:
				return
			case value, ok := <-c:
				if !ok {
					return
				}
				select {
				case out <- value:
				case <-done:
					return
				}
			}
		}
	}()
	return out
}

// Tee duplicates every value read from `in` onto two independent
// output channels. If done fires, both outputs close right away.
// Otherwise, each output closes on its own the moment every value has
// reached it, independent of how far behind the other one is.
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	out := make([]chan int, 2)
	wgs := make([]sync.WaitGroup, 2)

	for i := range out {
		out[i] = make(chan int)
	}

	go func() {
		for value := range orDone(done, in) {
			for i := range out {
				wgs[i].Go(func() {
					select {
					case <-done:
					case out[i] <- value:
					}
				})
			}
		}
		// Runs unconditionally, whether `in` closed or `done` fired.
		// Each output closes as soon as ITS OWN backlog (wgs[i]) is
		// done - out[0] doesn't wait on out[1], or vice versa.
		for i := range out {
			go func(i int) {
				wgs[i].Wait()
				close(out[i])
			}(i)
		}
	}()

	return out[0], out[1]
}
```

Design notes:

- **One `sync.WaitGroup` per output (`wgs[i]`), not one shared for both.** Every value spawns one fan-out goroutine per output via `wgs[i].Go(...)`, so `wgs[i]` only ever reaches zero once every value has actually been delivered (or abandoned via `done`) to `out[i]` specifically — no dependency on `out[1-i]`'s progress.
- **A dedicated closer goroutine per output.** Splitting `wgs[i].Wait(); close(out[i])` into two independent goroutines (one per index) is what lets `out[0]` close without waiting on `out[1]`'s closer to also be ready, and vice versa.
- **`orDone(done, in)` folds `done`-handling into the outer loop**, so the closer-spawning code after the loop runs unconditionally whether `in` was exhausted or `done` fired — no separate code path needed, and no risk of a bare `return` on a `done` case accidentally skipping the closers.
- **The per-value select still checks `done`** inside each `wgs[i].Go` goroutine, so a value stuck waiting on a stalled consumer doesn't block that goroutine (and thus `wgs[i].Wait()`) forever past shutdown.
- **One goroutine per value, per output, launched independently** is the piece the given starting code doesn't have: because every value's delivery to `out[i]` runs in its own goroutine rather than sharing one sequential per-value loop, one output's goroutines can all complete — whether or not the other output has been read at all — while the other output's goroutines sit blocked on their own sends. That's what lets `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` pass.

**Verified** in a scratch copy of `14b-tee-channel-independent-close/`: the given starting code passes the baseline and no-fixed-order tests but fails `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` exactly as described above; this fix passes the full six-test suite consistently under `go test -race -count=10 ./...`, with `go vet ./...` clean.

One caveat that applies regardless of which `Tee` implementation is used: `TestTeeStopsOnDoneRace` runs on the real clock (not wrapped in `synctest`), and its shutdown moment has an inherent, extremely rare timing race — `close(done)` firing and a per-value fan-out goroutine's `select { case <-done: ; case out[i] <- value: }` becoming ready to send can coincide, and Go's `select` breaks that tie arbitrarily. This is inherent to the exercise's real-clock shutdown test, not a defect in this fix.

## Alternative: one long-lived forwarder per output instead of one goroutine per value

The fix above spawns a fresh goroutine per value, per output (`wgs[i].Go(...)`), and never waits between values — `out[0]`'s and `out[1]`'s goroutines for value N and value N+1 are all in flight independently. That buys simplicity at a real cost: for a producer that outpaces its slowest consumer, goroutines and parked values pile up unboundedly (a silent `out2` consumer against `StartSensor(50)` leaves up to 50 goroutines blocked on `out[1] <- value`), and per-value ordering is no longer structural — it holds here only because two goroutines racing for the *same* channel's send queue resolve in launch order in practice, reinforced by `StartSensor`'s 5ms pacing giving each value ample time to be picked up before the next one is spawned. (Verified empirically: `go test -race -count=20` against this fix shows no ordering failures — the hazard is real in principle, not observed in practice at this pacing.)

The alternative is **one long-lived forwarder goroutine per output**, each draining its own explicit FIFO queue (a slice plus a `sync.Cond`, or a channel-based queue) that the reader goroutine appends to. Each forwarder pulls from its own queue in order and closes its own output once the reader has finished *and* its queue has drained — bounded to exactly 2 extra goroutines total instead of one per value, and ordering is structural (a FIFO queue can't reorder) rather than an artifact of scheduling. The cost is real: you now have to write and reason about the queue/signal machinery yourself instead of leaning on one `sync.WaitGroup` per output.

Neither design is wrong; which one to prefer depends on what you know about the workload. This exercise's fix takes the `wgs[i].Go` approach because the sensor here is small and bounded — but a producer with no upper bound on how far ahead of a stalled consumer it can run is exactly the case where the forwarder-queue design's bounded-goroutine, structural-ordering guarantees earn their extra complexity.

## Key takeaways

- A single goroutine that holds each value until *every* output has received it, one value at a time, is a complete and correct answer to "duplicate to both outputs, in no fixed order" — but it is fundamentally the wrong shape for "let each output close independently, however far apart the consumers are." No amount of rearranging that goroutine's closing logic fixes this; the delivery model itself has to change to one goroutine per value *per output*.
- Closing is a separate concern from delivery, and it needs its own independence: track completion **per output** (one `sync.WaitGroup` each) and give each output its own closer goroutine.
- `done` must be checked in the innermost per-value send, not just an outer receive loop — otherwise a value stuck waiting on a stalled consumer can hang that delivery (and its output's closer) forever past shutdown.
- Folding `done` into the same loop that reads `in` (via `orDone` or equivalent) means "input exhausted" and "cancelled early" reach the same cleanup code, so nothing after the loop gets silently skipped on the `done` path.
- When a test suite has multiple layers of strictness, expect a partially-correct-but-structurally-limited implementation to pass everything up to the layer its architecture can't support, then fail cleanly (if slowly/hangily) at exactly that layer — that's a precise diagnostic signal, not a sign something else is subtly broken.
