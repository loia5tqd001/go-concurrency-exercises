# Channel of Channels (Bridge Pattern) — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `13-channel-of-channels/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`StartLogHub` in `mockloghub.go` simulates a log system. New shards
connect over time. It returns a channel of channels. Each inner channel
carries one shard's lines and closes when that shard ends.
`StartLogHub` closes the outer channel after all shards start. The shards
may still send.

`Bridge` should merge these channels into one output stream. The input
channels are not known in advance. Close the output after `chanStream`
closes and every inner channel is empty. If `done` closes, close the
output and stop reading.

## Why the naive version is wrong

```go {1,12}
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

The starting `Bridge` reads one value from `chanStream`. It reads only the
first shard and never returns for another. When that shard closes,
`Bridge` returns. Other shards are still sending.

`TestBridgeFlattensAllShards` has 5 shards and 4 lines each, so 20 lines.
Only the first 4 reach the output. The other 16 are dropped. Their hub
goroutines can block forever.

`Bridge` must keep reading `chanStream` while it is open. It must also
keep draining every shard it receives. The number of inputs grows at
runtime.

## A tempting-but-incomplete fix: the sequential Bridge

This version looks complete. It uses the classic `bridge` shape from
*Concurrency in Go*. It also reuses
[07-or-done-channel](../07-or-done-channel) through `orDone`:

```go {7,8}
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

This version reads every shard and drains each one. It passes
`TestBridgeFlattensAllShards` and `TestBridgeStopsOnDone`.

It fails `TestBridgeDoesNotStarveOnSlowShard`. See `starvation_test.go`
and `README.md`. The outer `range` asks for the next shard only after the
inner `range` drains the current one. That test runs on the real clock,
not under `testing/synctest`.

Suppose shard 0 never sends or closes. Shard 1 is ready. The code stays
inside shard 0 and never reads shard 1. One slow shard blocks all shards
behind it. The first three tests do not catch this.

Do not tie reading the next shard to finishing the last one. Read
`chanStream` and every open shard at the same time. Both designs below
keep one stuck shard off the path that reads new shards.

## Approach 1: goroutine-per-shard fan-in with a `WaitGroup`

Use one dispatcher for `chanStream`. Each new shard gets its own
forwarder goroutine. That forwarder sends lines to the shared output and
calls `wg.Done()` when the shard closes.

Close the output after `chanStream` closes and `wg.Wait()` finishes. This
means every shard is empty. Check `done` in the dispatcher and every
forwarder. Closing it stops all blocked code.

```go {25,30,56}
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

Why this works:

- The dispatcher keeps reading `chanStream`. Each shard has its own
  forwarder, so shards run at the same time.
- Call `wg.Add(1)` before starting each forwarder. Calling it inside can
  race with `Wait` from `wg.Wait()`.
- Close the output only after `chanStream` ends and `wg.Wait()` returns.
  Every shard is then empty or stopped by `done`.
- Check `done` with `case <-done` in a `select` in the dispatcher, the
  shard read, and the `valStream` send. Every blocked point can stop.

## Approach 2: `reflect.Select` over a dynamically growing case list

This version avoids one goroutine per shard. `reflect.Select` waits on a
case list built at runtime. One goroutine watches `done`, `chanStream`,
and every open shard. The case list grows and shrinks.

```go {46,59}
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

Two easy mistakes:

- A closed channel is always ready. It returns zero with `ok == false`
  forever. Remove its case, or `reflect.Select` will keep choosing it.
  Call `removeCase` for `chanStream` and for each drained shard.
- `chosen` is an index into `cases` for one call. `cases` and `kinds`
  change only between calls, so the index is valid during the switch.
  Do not reuse it later.

**Tradeoff:** `reflect.Select` avoids many goroutines. It costs O(n) per
call for n cases. With m lines, total work is O(n·m). Approach 1 is O(1)
per line.

Go goroutines are cheap. This version is more complex and slower here. It
also loses compile-time type checks.
`recv.Interface().(<-chan string)` can panic if the value is not
`<-chan string`. Approach 1 would catch that type error at compile time.

`reflect.Select` chooses evenly among ready cases. It does not prioritize
`done`. In practice it notices within one or two loops, inside
`TestBridgeStopsOnDone`'s 200ms limit. Approach 1 has a stronger guarantee
because each goroutine checks `done`.

Use this for a very large unknown set of channels, where one goroutine
each is too costly. For this exercise, Approach 1 is simpler, faster, and
safer.

## Key takeaways

- Read `chanStream` more than once. Loop while it is open.
- Reading the next shard only after draining the last one still blocks
  behind a slow shard. Read all open shards at the same time.
- Call `sync.WaitGroup.Add` before starting the goroutine it counts.
- Close the output only after `chanStream` ends and every inner channel
  is empty. `wg.Wait()` or a single remaining `done` case can check this.
- Check `done` while reading the outer channel, reading a shard, and
  sending to the output.
- `reflect.Select` handles a runtime set of channels. It costs O(n) per
  call and loses compile-time type safety. A goroutine per input is often
  simpler and faster.
