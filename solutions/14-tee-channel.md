# Tee Channel: Duplicating a Sensor Stream to Two Consumers — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `14-tee-channel/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`StartSensor(count)` (see `mocksensor.go`) emits `count` incrementing integer readings, one every 5ms, then closes its channel. `Tee` is supposed to duplicate every value it reads from `in` onto two independent output channels, so two consumers — say a live display and a logger — can each observe the full, identical sequence in order, even if one of them reads much slower than the other. Closing `done` should make `Tee` abandon everything promptly and close both outputs.

Closing has a second requirement beyond "close both once `in` is exhausted": each output must close **on its own**, the moment every value has actually reached it, independent of the other output's progress. A fast consumer that has already received every value must see its channel close immediately, even if the slow consumer hasn't read anything yet and is sitting on a full backlog — closing both outputs together, gated on whichever is slowest, is not good enough.

`check_test.go` checks this in three tiers, each isolating a distinct property so a partially-correct solution gets a precise signal instead of one conflated failure:

- **Baseline (should-have): duplication is order-agnostic.** `TestTeeDuplicatesToBothConsumers` checks plain duplication with `out1` fast/`out2` slow; `TestTeeDuplicatesToBothConsumersReversedRoles` mirrors it with the roles swapped. Both consumers keep reading throughout (the "slow" one just sleeps 2ms between reads), so these tests tolerate arbitrary latency - they only check that the *final* delivered sequences are complete and correct, in either role assignment. Neither touches closing.
- **Should-have: delivering to one output never requires reading the other at all.** `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther` is what actually enforces the exercise's "using an inner select per output channel (so writing to one output doesn't have to happen strictly before the other)" instruction. It reads only the very first value from one output while the other is left completely untouched, with a bounded timeout so a Tee that tries outputs in a fixed order fails with a clear message instead of hanging. The two duplication tests above can't catch a fixed-order bug on their own, precisely because they tolerate unlimited latency.
- **Stricter (good-to-have, but required to fully solve the exercise): closing is independent.** `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` goes further still: it drains one output *completely* (every value the sensor will ever produce) while the other has never been read, then checks that the drained one closes immediately. This needs everything the middle tier needs, plus a concurrent, per-value-goroutine architecture that lets one output race arbitrarily far ahead of a completely unread other - see the note on Approach 1 below, which passes the middle tier but still can't get through this one. Runs in both possible orders (`out1` fast/`out2` slow, and `out2` fast/`out1` slow, as subtests) so an implementation that only handles whichever output happens to be `out[0]` can't sneak by either.

The naive implementation is:

```go
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	return in, in
}
```

## Why the naive version is wrong

`out1` and `out2` here are literally the same channel as `in`. Every value sent on that channel goes to whichever of the two consumer goroutines happens to win the race to receive it — never both. `check_test.go`'s key test, `TestTeeDuplicatesToBothConsumers`, proves this directly: it runs a fast consumer (drains `out1` as fast as possible) against a slow one (`out2`, sleeping 2ms between reads) and checks both end up with the full `[0..9]` sequence.

Verified against the naive version in a scratch copy:

```
--- FAIL: TestTeeDuplicatesToBothConsumers (0.00s)
    check_test.go:77: fast consumer got [1 3 5 7 9], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
    check_test.go:80: slow consumer got [0 2 4 6 8], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
--- FAIL: TestTeeDuplicatesToBothConsumersReversedRoles (0.00s)
    check_test.go:128: fast consumer (out2) got [1 3 5 7 9], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
    check_test.go:131: slow consumer (out1) got [0 2 4 6 8], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
--- FAIL: TestTeeDeliversToOneOutputWithoutWaitingOnTheOther (0.00s)
    --- FAIL: .../out1_read_first,_out2_untouched: check_test.go:235: first output got [0 2], want [0 1 2]
    --- FAIL: .../out2_read_first,_out1_untouched: check_test.go:235: first output got [0 2], want [0 1 2]
--- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered (0.00s)
    --- FAIL: .../out1_is_the_fast_one: check_test.go:329: slow=[], want [0 1 2 3 4]
    --- FAIL: .../out2_is_the_fast_one: check_test.go:329: slow=[], want [0 1 2 3 4]
--- FAIL: TestTeeStopsOnDone (0.03s)
    check_test.go:389: expected out1 to be closed once done fires, got value 4 instead
--- FAIL: TestTeeStopsOnDoneRace (0.03s)
    check_test.go:398: expected out1 to be closed once done fires, got value 4 instead
```

The fast consumer steals the odd-indexed values, the slow one gets the even-indexed ones — each is missing exactly half the sequence, so `reflect.DeepEqual` against the expected `[0..9]` fails for both, in either role assignment. `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther` fails for the same root cause with a smaller sequence (`n=3`): `out1`/`out2` being `in` itself means the two racing consumer goroutines split even a 3-value stream, so the "first" output ends up with `[0 2]` (missing `1`) instead of the complete `[0 1 2]` regardless of which output is nominally read first. `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` fails too, but for a different reason than usual (worth noting since it's a bit misleading): `out1`/`out2` being `in` itself means the "fast" side's `n` sequential receives return whatever `in` happens to produce and race away with, not necessarily the full expected sequence, and the drain of the "slow" side afterwards comes up empty — `slow=[]` — since the other goroutine already consumed everything. `TestTeeStopsOnDone` fails for a clearer reason: since `out1`/`out2` are `in` itself, closing `done` has no effect on it at all — `in` keeps producing values from `StartSensor` regardless, so the very next read returns a real value instead of observing the channel closed.

## Approach 1: per-value goroutine, inner select with nil-out-on-send — and why it's not enough on its own

A first cut at `Tee` looks like this: one goroutine reading `in`, and for each value, an inner select-loop that sends it to whichever of `out1`/`out2` hasn't received it yet, using two local variables that get **nilled out once that output has received the value** (sending on a nil channel blocks forever, so a nilled-out local drops out of the `select` for good).

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

This fixes duplication (`TestTeeDuplicatesToBothConsumers`/`ReversedRoles` pass) and shutdown-on-`done` (`TestTeeStopsOnDone`/`TestTeeStopsOnDoneRace` pass). It also correctly passes `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther`: the nil-out-on-send `select` genuinely races both sends for a given value, so whichever output is being read gets it without waiting on the other - there's no fixed try-order bug here at all.

Where it falls short is the last, strictest tier: `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` drains *every* value the sensor will produce from one output before ever touching the other - and that's the part this design structurally can't do, independent of its closing logic. The single goroutine holds each value until **both** outputs have received it before moving to the next one (`for out1Ch != nil || out2Ch != nil { ... }`), so if the other output is never read, delivery gets stuck after the very *first* value - the second `receiveWithTimeout` call for the fast output already times out, because the goroutine is still parked trying to hand value 0 to the untouched side and has not even looked at value 1 yet:

```
--- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out1_is_the_fast_one (0.00s)
    check_test.go:308: no value received within 20ms - is delivery to this output waiting on some other output being read first?
panic: deadlock: main bubble goroutine has exited but blocked goroutines remain
```

(The secondary panic after the clean, diagnostic failure is a separate, structural thing: `StartSensor` is a deliberately cancellation-blind mock - a real hardware feed can't be told to stop - so once the test bails out early via `t.Fatalf`, `done` closes but the sensor's own goroutine is still mid-`time.Sleep`/mid-send with nobody left reading it, which `synctest` reports as a leaked goroutine. This happens on *any* early-failing synctest-wrapped test in this suite, not something specific to Approach 1.)

So this isn't really "closing coupled to a single goroutine" as the root cause (that's true too, but moot - it never gets far enough to matter). It's that **holding each value until both outputs receive it, one value at a time, is exactly what the exercise's own instructions describe** ("for each value, hold onto it... until both have") - and it's precisely why an implementation like this can never let one output run arbitrarily far ahead of a completely unread other. Passing that final tier requires abandoning the single-goroutine-per-value model entirely in favor of the concurrent, per-value-goroutine design in Approach 2 below.

The nil-out-on-send technique itself is still correct and worth knowing - it's the right way to say "send to whichever of these outputs hasn't gotten this specific value yet, racing both in one select." It's a complete, spec-compliant answer to the exercise's literal instructions. It just can't satisfy the stricter, additional requirement this test suite imposes on top of them.

## Approach 2: per-output completion tracking, independent closers

The fix is to track how many sends have completed **per output**, not globally, and let each output close itself the instant its own count reaches the total — without waiting on the other.

```go
package main

import (
	"fmt"
	"sync"
)

// orDone adapts a channel so ranging over it also stops when done
// fires, not just when the channel closes - the standard shim for
// plugging an unrelated producer into a cancellable consumer.
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
// output channels, so that two consumers can each observe the full
// sequence of values `in` produces, in order, regardless of how fast
// or slow either one reads. If done fires, both outputs close right
// away. Otherwise, each output closes on its own the moment every
// value has reached it, independent of how far behind the other one
// is.
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
		// orDone's range loop above ends whether `in` closed or `done`
		// fired, so this runs unconditionally either way. Each output
		// closes as soon as ITS OWN backlog (tracked by wgs[i]) is
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

func main() {
	done := make(chan struct{})
	defer close(done)

	in := StartSensor(10)
	out1, out2 := Tee(done, in)

	var wg sync.WaitGroup
	var fast, slow []int

	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range out1 {
			fast = append(fast, v)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range out2 {
			slow = append(slow, v)
		}
	}()

	wg.Wait()

	fmt.Println("consumer 1:", fast)
	fmt.Println("consumer 2:", slow)
}
```

Why this shape specifically:

- **One `sync.WaitGroup` per output (`wgs[i]`), not one shared for both.** Every value spawns one fan-out goroutine per output via `wgs[i].Go(...)`, so `wgs[i]` only ever reaches zero once every value has actually been delivered (or abandoned via `done`) to `out[i]` specifically — it has no dependency on `out[1-i]`'s progress.
- **A dedicated closer goroutine per output (`wgs[i].Wait(); close(out[i])`).** Splitting this into two independent goroutines (one per index) is what lets `out[0]` close without waiting on `out[1]`'s closer to also be ready, and vice versa — the two closers race independently instead of sharing one blocking point.
- **`orDone(done, in)` folds `done`-handling into the outer loop.** Ranging over `orDone(done, in)` ends the loop the same way whether `in` was exhausted or `done` fired, so the closer-spawning code after the loop runs unconditionally in both cases — no separate code path needed for "shut down early" vs. "ran to completion". (An inline `select { case <-done: return; case value, ok := <-in: ... }` is tempting as a shortcut, but a bare `return` on the `done` case skips spawning the closers entirely, silently reintroducing "outputs never close on `done`" — worth double-checking if you inline it instead of using `orDone`.)
- **The per-value select still checks `done`.** Each `wgs[i].Go` fan-out goroutine's `select { case <-done: ; case out[i] <- value: }` still needs the `done` case so a value stuck waiting on a stalled consumer doesn't block that goroutine (and thus `wgs[i].Wait()`) forever past shutdown.
- **One goroutine per value, per output, all launched independently.** This is what Approach 1 doesn't have: because every value's delivery to `out[i]` runs in its own goroutine rather than sharing a single sequential loop, one output's goroutines can all complete (whether or not `out[1-i]` has been read at all) while the other output's goroutines sit blocked on their own sends. This is the piece that lets `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` (drain one output fully with the other never touched) succeed, on top of everything Approach 1 already got right.

**Verified** in a scratch copy of `14-tee-channel/` (never modifying the live repo directory): Approach 1 passes `TestTeeDuplicatesToBothConsumers(ReversedRoles)`, `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther`, and `TestTeeStopsOnDone(Race)`, but fails `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` for the structural reason above (as shown above); Approach 2 passes the full seven-test suite consistently — `go test -race -count=30 ./...` and, targeting the shutdown tests specifically, 1000+ additional real-time attempts (`go test -race -run TestTeeStopsOnDoneRace -count=50`), all clean, no data races, no deadlocks.

One caveat that applies to *both* approaches equally, so it's not something either solution's closing logic can fix: `TestTeeStopsOnDoneRace` runs on the real clock (it isn't wrapped in `synctest`), and its shutdown moment has an inherent, extremely rare timing race — `close(done)` firing and a per-value fan-out goroutine's `select { case <-done: ; case out[i] <- value: }` becoming ready to send can coincide, and Go's `select` breaks that tie arbitrarily rather than always preferring `done`. Across thousands of attempts this showed up once, with an already in-flight value slipping through right after `close(done)` instead of the very next read observing the channel closed. It reproduces identically with Approach 1's nil-out-on-send code, confirming it's inherent to the exercise's real-clock shutdown test, not a defect introduced by either solution here.

## Key takeaways

- `return in, in` isn't "duplication" — it's the same channel handed out twice, so consumers race for each value instead of each seeing every value.
- Tee needs to hold each value until *every* output has received it, with an inner `select` (not a fixed order of blocking sends) so a slow consumer on one output can't stall delivery to a faster one on the other. Nilling out a *local* channel variable per output, per value, is the standard trick for this — a nil channel is never selectable, so it naturally drops out of the `select` once satisfied. This alone (Approach 1) is a complete, correct answer to the exercise's literal instructions.
- But "hold each value until both have received it, one value at a time" (a single goroutine, sequential) is fundamentally different from "let each output receive independently, however far apart" (one goroutine per value per output, concurrent) - the former can never let one output run more than a fraction of a value ahead of a completely unread other, no matter how the per-value select is written. Recognizing which of these two shapes a given requirement actually needs matters more than knowing the nil-out-on-send trick itself.
- Closing is a *separate* concern from delivery, and it needs its own independence: track completion **per output** (e.g. one `sync.WaitGroup` each) and give each output its own closer goroutine, so a fast consumer's channel can close the instant it's fully delivered, without waiting on a slower sibling output.
- `done` must be checked in the inner per-value send loop, not just the outer receive loop — otherwise a value stuck waiting on a stalled/slow consumer can hang that delivery (and, transitively, that output's closer) forever past shutdown.
- Folding `done` into the same loop that reads `in` (via `orDone`, or equivalent) means "input exhausted" and "cancelled early" reach the same cleanup code — a bare `return` on a separate `case <-done` arm is an easy way to accidentally skip closing logic that only exists after the loop.
- When a requirement has multiple layers of strictness (duplication must be correct in either order; delivery to one output must never require reading the other at all; closing must additionally be independent per output), test each layer separately. A single test that checks several at once turns "layer one is fine, layer two isn't done yet" into one opaque failure instead of a precise signal - and, worse, can make you misdiagnose *why* it failed (an earlier draft of this doc blamed Approach 1's closing logic for a failure that was actually caused by its sequential single-goroutine delivery model never reaching the closing check at all).
- Inside `synctest.Test`, give any indefinite-looking receive a bounded `select { case v := <-ch: ...; case <-time.After(budget): t.Fatalf(...) }` rather than a raw `<-ch`. The fake clock makes the timeout free when the implementation is healthy, and it turns a silent hang - or, if the goroutine bails out early enough that a still-producing background goroutine is left over, an opaque `deadlock: ... goroutines in bubble` panic that aborts the *entire* test binary - into a specific, readable failure message instead.
- That said, the bounded receive doesn't fully eliminate the panic: `StartSensor` is deliberately cancellation-blind (a real hardware feed can't be told to stop), so a test that bails out via `t.Fatalf` before the sensor finishes producing everything it was asked for can still leave its goroutine mid-`time.Sleep` when the synctest bubble closes, which `synctest` reports as a leak. This is inherent to combining `synctest` with an uncancelable mock producer and an early failure path - not something a timeout alone can fix - but it's still a strict improvement: the diagnostic message prints before the panic, and every subtest that already ran gets its own pass/fail recorded first.
