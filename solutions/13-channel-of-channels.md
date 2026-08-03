# Channel of Channels (Bridge Pattern) — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `13-channel-of-channels/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`StartLogHub` (given, in `mockloghub.go`) simulates log-collecting
infrastructure where new "shard" sources connect over time. Instead of a
single channel of log lines, it returns a channel of channels: every value it
emits on the outer channel is itself a channel carrying one shard's log
lines, closing once that shard is done. `StartLogHub` closes the outer
channel once all shards have been *started* — but by then, the shards
themselves may still be producing lines in the background.

`Bridge` is supposed to flatten this channel-of-channels into a single
output stream — a fan-in, except the set of input channels isn't known
upfront and arrives dynamically over the bridge channel itself. The output
must close once `chanStream` is closed **and** every inner channel it ever
produced has been fully drained, and `Bridge` must stop promptly (closing
its output and abandoning all reads) as soon as `done` is closed.

## Why the naive version is wrong

```go
stream, ok := <-chanStream
if !ok {
	return
}

for {
	select {
	case <-done:
		return
	case v, ok := <-stream:
		if !ok {
			return // <- returns after the FIRST shard closes
		}
		...
	}
}
```

The naive `Bridge` reads exactly one value off `chanStream` — the first
shard — and then never goes back for more. Once that first shard's channel
closes, `Bridge` returns and closes its output, even though `chanStream` may
still have more shards coming and the hub is still producing lines for them
in the background. Against `TestBridgeFlattensAllShards` (5 shards × 4 lines
= 20 total), only the first shard's 4 lines ever make it out — the other 16
are silently dropped on the floor, and the hub's producer goroutines for
those shards end up permanently blocked trying to send to a `Bridge` that
will never read from them again (which is also why that test intentionally
runs on the real clock rather than under `testing/synctest` — see the test's
own comment).

The fix has to keep going back to `chanStream` for as long as it's open, and
has to keep draining every shard channel it has ever received, not just the
most recent one — a fan-in where the number of inputs grows at runtime.

## A tempting-but-incomplete fix: the sequential Bridge

There's a second version that's easy to land on instead — it's the classic
`bridge` shape from *Concurrency in Go* itself, and it's a natural thing to
reach for since `orDone` (from
[07-or-done-channel](../07-or-done-channel)) is sitting right there ready to
reuse:

```go
func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string {
	valStream := make(chan string)

	go func() {
		defer close(valStream)

		for lineStream := range orDone(done, chanStream) {
			for line := range orDone(done, lineStream) {
				select {
				case <-done:
					return
				case valStream <- line:
				}
			}
		}
	}()

	return valStream
}
```

This *does* go back to `chanStream` for every shard, and it *does* drain each
one fully, so it passes `TestBridgeFlattensAllShards` and
`TestBridgeStopsOnDone` — it looks like a complete fix. It fails
`TestBridgeDoesNotStarveOnSlowShard` (see `starvation_test.go` and
`README.md`), because the outer `range` only asks `chanStream` for the
*next* shard once the inner `range` has fully drained the *current* one.
Concretely: with a stuck shard 0 (never sends, never closes) followed by a
ready shard 1, this version never even reaches the receive that would pick
shard 1 up off `chanStream` — it's still parked inside shard 0's inner loop,
which blocks forever. A single wedged or merely slow shard therefore starves
every shard behind it, including ones not yet read off `chanStream` at all —
exactly the head-of-line blocking a log hub can't afford, even though
nothing in the *first* three tests would ever catch it.

The fix has to stop coupling "read the next shard" to "finish the previous
one": `chanStream` and every open shard need to be drained concurrently, not
one at a time. Both approaches below do that by never letting one shard's
receive be on the critical path of reading the next.

## Approach 1: goroutine-per-shard fan-in with a `WaitGroup`

Keep a single dispatcher goroutine reading `chanStream` in a loop. Each time
a new shard channel arrives, spawn a dedicated goroutine that forwards that
shard's lines into the shared output and calls `wg.Done()` when the shard
closes. The output channel closes once `chanStream` itself is closed *and*
`wg.Wait()` confirms every spawned shard-forwarder has finished — which is
exactly "chanStream closed and every shard drained." `done` is checked in
both the dispatcher's loop and each per-shard forwarder, so closing it stops
everything promptly regardless of which channel a goroutine happens to be
blocked on.

```go
package main

import (
	"fmt"
	"sync"
)

// Bridge flattens a channel-of-channels into a single output channel
// of values. It keeps reading chanStream for as long as it's open,
// spawning one goroutine per inner channel received to forward that
// shard's lines into the shared output. The output channel closes once
// chanStream is closed AND every inner channel it ever produced has
// been fully drained - or promptly, if done is closed first.
func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string {
	valStream := make(chan string)

	go func() {
		defer close(valStream)

		var wg sync.WaitGroup

	loop:
		for {
			select {
			case stream, ok := <-chanStream:
				if !ok {
					break loop
				}

				wg.Add(1)
				go func(s <-chan string) {
					defer wg.Done()

					for {
						select {
						case v, ok := <-s:
							if !ok {
								return
							}
							select {
							case valStream <- v:
							case <-done:
								return
							}
						case <-done:
							return
						}
					}
				}(stream)

			case <-done:
				break loop
			}
		}

		wg.Wait()
	}()

	return valStream
}
```

Why this satisfies the requirements:

- The dispatcher loop keeps calling back into `chanStream` for as long as
  it's open, instead of stopping after the first value — that's the core
  fix. Each new shard gets its own forwarder goroutine, so shards are
  drained concurrently, not one-at-a-time.
- `wg.Add(1)` happens *before* the forwarder goroutine is spawned (not
  inside it), so there's no race between the dispatcher deciding it's done
  with `chanStream` and a shard's `wg.Done()` racing `wg.Wait()` — a classic
  `WaitGroup` footgun avoided.
- The output only closes after both `chanStream` is exhausted *and*
  `wg.Wait()` returns, i.e. every forwarder has seen its shard close (or
  `done` fire) — matching "closes once chanStream has been closed AND every
  inner channel has been fully drained."
- `done` is honored at three points — the dispatcher's `select`, each
  forwarder's outer `select`, and the nested `select` guarding the send to
  `valStream` — so no goroutine can get stuck no matter which channel it's
  waiting on when `done` closes.

## Approach 2: `reflect.Select` over a dynamically growing case list

An alternative that avoids spawning a goroutine per shard: `reflect.Select`
lets you wait on a slice of cases built at runtime, so a single goroutine can
directly watch `done`, `chanStream`, and every currently-open shard channel
at once, growing and shrinking that case list as shards arrive and finish.

```go
package main

import (
	"fmt"
	"reflect"
)

// caseKind tags what each reflect.SelectCase in Bridge's dynamic case
// list represents, since indices shift around as cases are added and
// removed.
type caseKind int

const (
	kindDone caseKind = iota
	kindChanStream
	kindShard
)

// Bridge flattens a channel-of-channels into a single output channel
// of values using reflect.Select to wait on a dynamically growing and
// shrinking set of channels: chanStream itself (for new shards) plus
// one case per shard channel currently open. New shards add a case;
// a shard closing removes its case; chanStream closing removes its
// case. Bridge is done once only the done case is left, meaning
// chanStream is closed and every shard has been fully drained.
func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string {
	valStream := make(chan string)

	go func() {
		defer close(valStream)

		cases := []reflect.SelectCase{
			{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(done)},
			{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(chanStream)},
		}
		kinds := []caseKind{kindDone, kindChanStream}

		removeCase := func(i int) {
			cases = append(cases[:i], cases[i+1:]...)
			kinds = append(kinds[:i], kinds[i+1:]...)
		}

		for {
			// Only the done case left means chanStream is closed and
			// every shard we ever received has been drained - done.
			if len(cases) == 1 {
				return
			}

			chosen, recv, ok := reflect.Select(cases)

			switch kinds[chosen] {
			case kindDone:
				return

			case kindChanStream:
				if !ok {
					// chanStream closed - stop watching it.
					removeCase(chosen)
					continue
				}
				stream := recv.Interface().(<-chan string)
				cases = append(cases, reflect.SelectCase{
					Dir: reflect.SelectRecv, Chan: reflect.ValueOf(stream),
				})
				kinds = append(kinds, kindShard)

			case kindShard:
				if !ok {
					// This shard is fully drained - stop watching it.
					removeCase(chosen)
					continue
				}
				select {
				case valStream <- recv.String():
				case <-done:
					return
				}
			}
		}
	}()

	return valStream
}
```

Two details that are easy to get wrong here, both handled above:

- A closed channel is always "ready" in a `select` (it returns its zero
  value with `ok == false` immediately, forever). If the `chanStream` case
  were left in the slice after it closes, `reflect.Select` would keep
  picking that permanently-ready case over and over, busy-spinning instead
  of doing useful work. `removeCase` is called for it exactly like it is for
  a drained shard.
- `chosen` is an index into `cases` at the moment `reflect.Select` returns.
  Since `cases` and the parallel `kinds` slice are only mutated in between
  calls to `reflect.Select` (never concurrently), that index stays valid —
  but it's specific to *that* call, so nothing about it is cached or reused
  across iterations.

**Trade-off, and it's not in this approach's favor.** The usual reason to
reach for `reflect.Select` is "avoid spawning a goroutine per channel" — but
`reflect.Select` itself is O(n) per call over the current case count. With n
shards open and m total lines to forward, that's O(n·m) work overall, versus
Approach 1's O(1) per line (each forwarder only ever selects over its own
shard, `done`, and the output). Goroutines are cheap in Go; here the
"lighter-weight" alternative is both more complex *and* asymptotically
slower at the exact thing it was reached for. It also trades compile-time
safety for a runtime one: `recv.Interface().(<-chan string)` panics if a
`chanStream` value ever isn't actually a `<-chan string`, a mismatch
Approach 1's plain Go channel types would catch at compile time. And because
`reflect.Select` picks uniformly among all ready cases rather than
prioritizing `done`, reacting to `done` isn't instantaneous the way a
dedicated `case <-done` at the top of a small `select` is — it's prompt in
practice (caught within an iteration or two, comfortably inside the 200ms
bound `TestBridgeStopsOnDone` allows), just not as structurally guaranteed as
Approach 1's per-goroutine `done` checks.

Worth knowing as the answer to "how would you fan-in over a truly unknown
and large number of channels without one goroutine each" — but for this
exercise's shard counts, Approach 1 is simpler, faster, and safer.

## Key takeaways

- A dispatcher that only reads its channel-of-channels *once* is the
  signature bug of this pattern — the fix always involves looping on the
  outer channel for as long as it's open, not just handling its first value.
- Looping back to `chanStream` is necessary but not sufficient: doing so
  only *after* fully draining the current shard (the classic sequential
  `bridge` pattern) still starves every later shard behind a stuck or slow
  one. Draining chanStream and every open shard concurrently — not one at a
  time — is what actually delivers on "fan-in over a dynamically arriving
  set of channels."
- `sync.WaitGroup.Add` must happen before the goroutine it counts is
  spawned, never inside it, or `Wait` can race a goroutine that hasn't
  registered yet.
- "Closed once the source is closed AND every derived stream is drained" is
  a two-part condition — `wg.Wait()` (or, in the reflect version, "only the
  done case remains") has to capture both halves, not just one.
- `done` needs to be checked at every point a goroutine could otherwise
  block indefinitely — reading the outer channel, reading an inner channel,
  and sending to the output — not just once at the top of a loop.
- `reflect.Select` is a real tool for "wait on a runtime-determined set of
  channels," but it's O(n) per call and gives up compile-time channel-type
  safety; a goroutine-per-input fan-in is usually both simpler and faster
  unless the channel count is large enough that per-goroutine overhead
  actually dominates.
