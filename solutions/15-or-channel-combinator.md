# Or-Channel Combinator: Combining Independent Shutdown Triggers — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `15-or-channel-combinator/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

A service often needs to shut down as soon as ANY of several independent triggers fires — a failed health check, an admin-requested shutdown, a deadline expiring. Each trigger is its own `<-chan struct{}` that gets closed the moment its condition occurs. `or` is supposed to combine an arbitrary, variadic number of such signal channels into a single channel that closes as soon as ANY ONE of the inputs closes — no matter which one, and no matter how many channels there are (including 0 or 1).

The naive implementation only ever watches `channels[0]`:

```go
func or(channels ...<-chan struct{}) <-chan struct{} {
	orDone := make(chan struct{})
	if len(channels) == 0 {
		return orDone
	}
	go func() {
		defer close(orDone)
		<-channels[0]
	}()
	return orDone
}
```

## Why the naive version is wrong

Closing any channel *other than* `channels[0]` has no effect at all — the combined channel just sits there, blocked forever, even though one of the shutdown triggers already fired. `check_test.go`'s key test, `TestOrFiresOnAnyChannel`, closes `chans[3]` out of 5 and expects `or()` to unblock promptly; `TestOrHandlesManyChannels` does the same with 20 channels, closing index 12.

Verified against the naive version in a scratch copy:

```
--- FAIL: TestOrFiresOnAnyChannel (0.30s)
    check_test.go:69: or() did not fire within 300ms after channels[3] closed - looks like or() isn't watching every channel it was given (only channels[0]?)
--- FAIL: TestOrHandlesManyChannels (0.30s)
    check_test.go:131: or() with 20 channels did not fire within 300ms after channels[12] closed
```

Both failures are clean timeouts (the tests guard their blocking receive with `select` + `time.After(300ms)`), not panics — which matters here specifically because these two tests deliberately run on the real clock instead of inside `synctest.Test`. Inside a `synctest` bubble, a goroutine that never unblocks and has no fake time left to advance makes every goroutine in the bubble "durably blocked," which `synctest` reports as a fatal deadlock panic that would crash the whole test binary rather than failing the test cleanly. `TestOrFiresOnFirstChannel` (closes `channels[0]`) and `TestOrHandlesEdgeCases` (0 and 1 channels) pass even against the naive code — they exercise exactly the one case the buggy implementation accidentally gets right, plus edges it doesn't touch at all.

## Approach 1: flat fan-out with `sync.Once` (recommended default)

The simplest design that satisfies every requirement without any recursion: spawn one goroutine per input channel, each racing the shared output channel against its own input, and let `sync.Once` decide who gets to close it.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// or combines any number of done/signal channels into a single
// channel that closes as soon as ANY of the input channels closes.
func or(channels ...<-chan struct{}) <-chan struct{} {
	orDone := make(chan struct{})
	var once sync.Once
	for i := range channels {
		go func() {
			select {
			case <-orDone:
			case <-channels[i]:
				once.Do(func() {
					close(orDone)
				})
			}
		}()
	}
	return orDone
}

func main() {
	healthCheckFailed := make(chan struct{})
	adminShutdown := make(chan struct{})
	deadlineExceeded := make(chan struct{})

	go func() {
		time.Sleep(50 * time.Millisecond)
		close(healthCheckFailed)
	}()

	start := time.Now()
	combined := or(healthCheckFailed, adminShutdown, deadlineExceeded)
	<-combined
	elapsed := time.Since(start)

	fmt.Printf("shutdown signal received after %s (triggered by healthCheckFailed)\n", elapsed)
}
```

Why it's correct, including the two base cases the other approaches special-case explicitly:

- **Zero channels**: the loop body never runs, so no goroutine ever exists to close `orDone` — it just sits there forever. Same outcome as Approaches 2 and 3 below, reached without a dedicated `case 0` branch.
- **One channel**: one goroutine is spawned, racing `orDone` against that single channel. If the channel never closes, that goroutine blocks forever — but that's *correct*, not a leak: its lifetime is exactly `or`'s own intended lifetime for this call (if the only input never fires, `or` shouldn't fire either). It does cost one goroutine the README's suggested direct `return channels[0]` avoids entirely, which is this approach's one deviation from the spec's called-out guidance — harmless, just not free.
- **N > 1**: every goroutine watches `orDone` in addition to its own channel, so whichever channel closes first wins the race for `once.Do`, and every other still-waiting goroutine wakes via the now-closed `orDone` and exits. There's no recursive tree and therefore no orphaning trap to get right in the first place — the same reason Approach 2 (`reflect.Select`) below doesn't need one either.

**Cost.** This spawns exactly N goroutines — one per input channel, always, even for the trivial N=1 case. In exchange, every goroutine's job is identical and symmetric (race my channel against the shared done-signal), it reacts to a winning channel in a single hop (no chain of nested selects to climb, unlike Approach 3 below), and there's no reflection and no recursive leak trap to get right. See Approaches 2 and 3 for how the O(1)-goroutine and recursive alternatives compare.

**Verified** in a scratch copy of `15-or-channel-combinator/` (never modifying the live repo directory): the naive `main.go` fails `TestOrFiresOnAnyChannel` and `TestOrHandlesManyChannels` with clean timeouts (not panics) as shown above, while `TestOrFiresOnFirstChannel` and `TestOrHandlesEdgeCases` already pass. Swapping in the solution above, `go test -race -count=10 ./...` passes cleanly, 10/10 runs, no data races, covering 0, 1, and many (20) channels.

## Approach 2: `reflect.Select` over a single flat case list

A genuinely different design for the "more than one channel" case: instead of spawning a goroutine per input channel, construct one `[]reflect.SelectCase` covering *all* N channels up front, and let a single goroutine block on all of them at once via `reflect.Select`.

```go
package main

import (
	"fmt"
	"reflect"
	"time"
)

// or combines any number of done/signal channels into a single
// channel that closes as soon as ANY of the input channels closes.
//
// This version builds one flat reflect.Select over all N channels at
// once instead of recursing: a single goroutine blocks on all of them
// simultaneously and returns as soon as any one becomes ready.
func or(channels ...<-chan struct{}) <-chan struct{} {
	orDone := make(chan struct{})

	switch len(channels) {
	case 0:
		return orDone
	case 1:
		return channels[0]
	}

	cases := make([]reflect.SelectCase, len(channels))
	for i, c := range channels {
		cases[i] = reflect.SelectCase{
			Dir:  reflect.SelectRecv,
			Chan: reflect.ValueOf(c),
		}
	}

	go func() {
		defer close(orDone)
		reflect.Select(cases)
	}()

	return orDone
}

func main() {
	healthCheckFailed := make(chan struct{})
	adminShutdown := make(chan struct{})
	deadlineExceeded := make(chan struct{})

	go func() {
		time.Sleep(50 * time.Millisecond)
		close(healthCheckFailed)
	}()

	start := time.Now()
	combined := or(healthCheckFailed, adminShutdown, deadlineExceeded)
	<-combined
	elapsed := time.Since(start)

	fmt.Printf("shutdown signal received after %s (triggered by healthCheckFailed)\n", elapsed)
}
```

The two base cases (0 and 1 channels) are identical to Approach 1 for the same reasons given above — those aren't where the two approaches diverge.

Where they genuinely differ, for N > 1 channels:

- **Goroutine count.** Approach 1 spawns exactly N goroutines, one per input channel, all racing the shared `orDone` against their own channel. Approach 2 spawns exactly **one** goroutine total, regardless of N, blocked in a single `reflect.Select` over a flat, N-case list.
- **Propagation.** Both are flat, non-recursive designs, so both react to whichever channel wins in a single hop — no chain of nested selects to climb, unlike Approach 3's recursive design below.
- **Cost tradeoff.** `reflect.Select` has to build a `[]reflect.SelectCase` (one allocation-heavy value per channel) and pay reflection overhead on every call, which Approach 1's compile-time `select` per goroutine doesn't. In exchange, it uses a fixed 1 goroutine instead of N, which starts to matter once N reaches into the thousands.

Both are correct; which one to reach for is a call between "no reflection, compile-time channel typing, O(N) goroutines" (Approach 1) and "O(1) goroutines, at the cost of reflection overhead and losing compile-time channel-type checking" (Approach 2).

**Verified** in the same scratch copy, swapping Approach 1's `main.go` for the `reflect.Select` version above: `go test -race -count=10 ./...` passes cleanly, 10/10 runs, no data races — including the 0-channel, 1-channel, and 20-channel (`TestOrHandlesManyChannels`) cases.

## Approach 3: recursive divide-and-conquer (the classic textbook idiom)

The idiom most commonly cited for this problem (e.g. Katherine Cox-Buday's *Concurrency in Go*), and the one this exercise's own README walks through: watch `channels[0]` and `channels[1]` directly in a `select`, and fold everything else into a single recursive third branch. It's included here for that reason, and because its leak trap is a genuinely instructive lesson about channel/goroutine lifetime — not because it outperforms Approaches 1 or 2. See the caveats at the end of this section before reaching for it in real code.

```go
package main

import (
	"fmt"
	"time"
)

// or combines any number of done/signal channels into a single
// channel that closes as soon as ANY of the input channels closes.
func or(channels ...<-chan struct{}) <-chan struct{} {
	orDone := make(chan struct{})

	switch len(channels) {
	case 0:
		return orDone
	case 1:
		// Nothing to combine it with: hand the caller's own channel
		// back unchanged. No new goroutine needed - and spawning one
		// here that just relays a single, possibly-never-closed
		// channel would leak forever once the rest of the select
		// chain above it has already fired on some other branch.
		return channels[0]
	}

	go func() {
		defer close(orDone)

		// Thread this level's own orDone into the recursive tail
		// alongside the channels we haven't looked at yet. That way,
		// if THIS select fires because of channels[0] or channels[1],
		// closing orDone (via the defer above) also unblocks whatever
		// goroutine the recursive or() call below spawned - instead
		// of leaving it orphaned forever, still waiting on channels
		// further down the list that may never close.
		tail := make([]<-chan struct{}, 0, len(channels)-1)
		tail = append(tail, channels[2:]...)
		tail = append(tail, orDone)

		select {
		case <-channels[0]:
		case <-channels[1]:
		case <-or(tail...):
		}
	}()

	return orDone
}

func main() {
	healthCheckFailed := make(chan struct{})
	adminShutdown := make(chan struct{})
	deadlineExceeded := make(chan struct{})

	go func() {
		time.Sleep(50 * time.Millisecond)
		close(healthCheckFailed)
	}()

	start := time.Now()
	combined := or(healthCheckFailed, adminShutdown, deadlineExceeded)
	<-combined
	elapsed := time.Since(start)

	fmt.Printf("shutdown signal received after %s (triggered by healthCheckFailed)\n", elapsed)
}
```

Why the two base cases matter, not just the recursive step:

- **Zero channels**: nothing to react to. Returning a channel that's never closed is the only sane behavior — there is no trigger to wait for, so the function must not fabricate one that fires on its own.
- **One channel**: return it directly, don't wrap it in a relay goroutine. A relay (`go func() { defer close(orDone); <-channels[0]; }()`) looks harmless, but it has no way to know when to give up — if that single channel is one of several independent triggers that *doesn't* end up firing (completely normal — only one trigger fires in practice), the relay goroutine blocks on it forever. `TestOrHandlesEdgeCases`'s "one channel" subtest exercises exactly this path.

The trap in the recursive case, spelled out: if you recurse on plain `or(channels[2:]...)`, and *this* level's `select` happens to fire because of `channels[0]` or `channels[1]` — not the recursive branch — the goroutine spawned by that recursive call is left behind. It's still blocked in its own `select`, waiting on channels further down the list that may never close, forever. That's a goroutine leak on *every single call* where the winning channel isn't in the deepest recursion level — which, for a signal fired somewhere in the middle of a long channel list, is the common case, not a corner case.

The fix is to fold this level's own `orDone` into what gets recursed on: `or(append(channels[2:], orDone)...)`. Since `orDone` is closed via `defer` no matter which branch of *this* `select` fires, closing it also unblocks the recursive call's `select` (via its own `<-or(tail...)` branch, which bottoms out on this `orDone`), so that goroutine gets to return and exit instead of being orphaned. The same reasoning applies transitively at every level of the recursion, all the way down — each level's shutdown collapses the ones below it.

**Why this isn't better than Approach 1, despite the name.** Despite the "divide-and-conquer" label, this recursion doesn't split the channel list in half each level — it peels off a constant 2 channels (`channels[0]`, `channels[1]`) and folds the remaining N-2 back together with 1 new `orDone`, so the next level always has N-1 channels, not N/2. That makes it a **linear chain**, not a balanced tree: recursion depth is O(N), not O(log N). Total goroutine count still comes out to a fixed **N-1** for N channels — any binary tree combining N leaves has exactly N-1 internal nodes, whether balanced or a straight chain — so it's the same *order* as Approach 1's N, not fewer.

Worse, the linear shape costs real propagation latency that Approaches 1 and 2 don't pay: if the channel that fires is buried deep in the tail (e.g. `channels[12]` of 20), the "done" signal has to climb one recursion level at a time — the level that directly saw the win closes its own `orDone`, which is exactly what the level above it is blocked selecting on, waking it to close *its* `orDone`, and so on up to the top. That's O(depth) = O(N) sequential goroutine wake-ups in the worst case, versus Approach 1's and Approach 2's O(1) — whichever goroutine sees the winning channel closes the *one shared* output directly, no chain to climb.

A genuinely balanced variant exists — split the list in half and recurse on each half (`or(or(left...), or(right...))`) — which gets recursion depth down to O(log N) while keeping the same N-1 total goroutines. That's likely what gets remembered as "halving" when this idiom is discussed: not fewer total goroutines, just a shallower tree. It isn't included here as its own approach because it doesn't change the fundamental trade-off against Approaches 1 and 2 — still O(N) total goroutines, still more code than either — and its one real advantage, shallower depth, is immaterial for the handful of channels this exercise actually combines.

**Verified** in the same scratch copy, swapping in the version above: `go test -race -count=5 ./...` passes cleanly, 5/5 runs, no data races, covering 0, 1, and many (20) channels.

## Key takeaways

- Watching only `channels[0]` is a common naive shape for variadic "combine these signals" helpers — it happens to pass any test that only ever closes the first channel, which is why `TestOrFiresOnFirstChannel` alone wouldn't have caught this bug.
- The 0-channel and 1-channel base cases aren't just tidiness — the 1-channel case in particular has a real trap: wrapping a single passthrough channel in a relay goroutine leaks that goroutine forever whenever the channel it watches is never closed, which is the normal case for one of several independent triggers.
- A flat fan-out with `sync.Once` (Approach 1) is the simplest correct design: every goroutine's job is identical and symmetric, there's no recursion and therefore no leak trap to get right, and it reacts to a winning channel in a single hop. Its only cost is O(N) goroutines instead of O(1).
- `reflect.Select` (Approach 2) offers a genuinely different structural tradeoff: one goroutine and one flat N-way select instead of N separate goroutines — same O(1)-hop propagation as Approach 1, at the cost of reflection overhead and an allocation-heavy `[]reflect.SelectCase` built on every call.
- The classic recursive `or` idiom (Approach 3) is the one most often cited in textbooks and blog posts, and it's what this exercise's README asks for — but despite being called "divide-and-conquer," it peels off a constant 2 channels per level rather than splitting the list in half, making it a linear chain (O(N) depth) rather than a balanced tree (O(log N) depth). It has the same trap either way: recursing on `or(channels[2:]...)` unmodified orphans a goroutine every time the *current* level's select wins on `channels[0]`/`channels[1]` instead of the recursive branch. Folding this level's own `orDone` into the recursive tail (`or(append(channels[2:], orDone)...)`) fixes that, but even fixed, the linear shape means a signal buried deep in the channel list takes O(N) sequential goroutine wake-ups to reach the top-level output — worse than Approaches 1 and 2's O(1). Its value is pedagogical, not performance.
- Tests that must observe a *hang* (not just a value) can't safely run inside `testing/synctest`'s fake-clock bubble: a goroutine that's supposed to never unblock makes the whole bubble "durably blocked," which `synctest` treats as a fatal deadlock and panics instead of letting the test fail normally. That's why `TestOrFiresOnAnyChannel` and `TestOrHandlesManyChannels` here use the real clock with `select` + `time.After` instead.
