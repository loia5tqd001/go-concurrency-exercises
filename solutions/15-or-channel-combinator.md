# Or-channel combinator: combine shutdown signals

> **Spoiler warning.** This file has full solutions for `15-or-channel-combinator/`. Try the exercise first. Come back if you get stuck.

## The problem

A service may need to stop when any one of several events occurs. Examples include a failed health check, an admin shutdown, or an expired deadline.

Each event has its own `<-chan struct{}`. The channel closes when the event happens. `or` must combine any number of these channels into one output.

The output must close when any input closes. It must work for any input, and for 0 or 1 channels.

The naive version watches only `channels[0]`:

```go {8}
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

## Why the naive version fails

If any other input closes, nothing happens. The combined channel stays blocked forever.

`TestOrFiresOnAnyChannel` closes `chans[3]` out of 5. It expects `or()` to return at once. The test lives in `check_test.go`.

`TestOrHandlesManyChannels` uses 20 channels and closes index 12. It has the same expectation.

I ran the naive version in a scratch copy:

```
--- FAIL: TestOrFiresOnAnyChannel (0.30s)
    check_test.go:69: or() did not fire within 300ms after channels[3] closed - looks like or() isn't watching every channel it was given (only channels[0]?)
--- FAIL: TestOrHandlesManyChannels (0.30s)
    check_test.go:131: or() with 20 channels did not fire within 300ms after channels[12] closed
```

Both failures are clean timeouts. The tests use `select` and `time.After(300ms)`.

These tests use the real clock, not `synctest.Test`. In a `synctest` bubble, a blocked goroutine with no fake time can mark all goroutines as blocked. `synctest` then crashes the whole test binary with a deadlock panic.

`TestOrFiresOnFirstChannel` and `TestOrHandlesEdgeCases` pass against the naive code. The first test closes `channels[0]`, the one case the bug handles. The second test covers 0 and 1 channels.

## Approach 1: flat fan-out with `sync.Once` (recommended default)

This is the simplest design without recursion. Start one goroutine per input. Each goroutine watches its own input and the shared output. `sync.Once` decides which one closes the output.

```go {17,18,19,20}
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

Here is why it works, including the 0 and 1 channel cases:

- Zero channels: the loop does not run. Nothing closes `orDone`, so it stays open forever. This matches Approaches 2 and 3, without a `case 0` branch.
- One channel: one goroutine watches `orDone` and that channel. If the input never closes, the goroutine waits forever.
- That wait is not a leak. The goroutine lives as long as this `or` call. If the only input never fires, `or` must not fire.
- This version uses one goroutine where the README suggests `return channels[0]`. That is harmless, but it has a cost.
- N > 1: every goroutine watches `orDone` and its own input. The first input to close wins `once.Do`.
- The closed `orDone` wakes every other goroutine, and they exit.
- There is no recursive tree, so there is no orphan trap. Approach 2 has the same benefit.

This version starts N goroutines, one per input. It pays that cost even when N is 1. All goroutines do the same job.

The result reacts in one hop. There is no nested select chain. It uses no reflection and has no recursive leak trap.

Approaches 2 and 3 show the O(1)-goroutine and recursive alternatives.

I tested this in a scratch copy of `15-or-channel-combinator/`. The naive `main.go` fails the two timeout tests above.

`TestOrFiresOnFirstChannel` and `TestOrHandlesEdgeCases` pass against the naive code. The solution passes `go test -race -count=10 ./...` in all 10 runs.

The run found no data races. It covered 0, 1, and 20 channels.

## Approach 2: `reflect.Select` over a single flat case list

This is a different design for more than one channel. Build one `[]reflect.SelectCase` for all N inputs. Then one goroutine blocks on all of them with `reflect.Select`.

```go {25,35}
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

The 0 and 1 channel cases match Approach 1. The approaches differ only for N > 1.

For N > 1 inputs:

- Approach 1 starts N goroutines. Approach 2 starts one goroutine, no matter how large N is.
- That one goroutine blocks in a flat, N-case `reflect.Select`.
- Both designs are flat. Both react in one hop. Approach 3 uses a recursive chain.
- `reflect.Select` builds one allocation-heavy `[]reflect.SelectCase` value per channel. It also pays reflection cost on every call.
- Approach 1 avoids that cost with a compile-time `select`.
- Approach 2 uses one goroutine instead of N. This matters when N reaches the thousands.

Both designs work. Approach 1 has no reflection, compile-time channel types, and O(N) goroutines.

Approach 2 has O(1) goroutines, reflection cost, and no compile-time channel-type check.

I tested the `reflect.Select` version in the same scratch copy. `go test -race -count=10 ./...` passed all 10 runs.

It found no data races. The runs covered 0, 1, and 20 channels, including `TestOrHandlesManyChannels`.

## Approach 3: recursive divide-and-conquer (the classic textbook idiom)

Textbooks often cite this idiom. Katherine Cox-Buday's *Concurrency in Go* uses it. The exercise README also walks through it.

Watch `channels[0]` and `channels[1]` in a `select`. Put all other channels in a recursive third branch.

This section includes it because the README asks for it. Its leak trap also teaches an important lesson about goroutine lifetime. It is not faster than Approaches 1 or 2.

Read the caveats before using it in real code.

```go {22,35,36,37,42}
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

The two base cases matter as much as the recursive step:

- Zero channels: there is no input to watch. Return a channel that never closes. Never invent a trigger.
- One channel: return it directly. Do not wrap it in a relay goroutine.
- A relay such as `go func() { defer close(orDone); <-channels[0]; }()` has no way to stop.
- Usually only one trigger fires. A relay for an input that never closes waits forever.
- The "one channel" subtest of `TestOrHandlesEdgeCases` covers this path.

The recursive case has a trap. Suppose the code recurses with `or(channels[2:]...)`.

Then this level's `select` fires on `channels[0]` or `channels[1]`, not the recursive branch. The recursive goroutine is left behind.

It still waits on lower channels that may never close. This leaks a goroutine whenever the winner is not in the deepest level.

That is common when a signal comes from the middle of a long list.

The fix adds this level's `orDone` to the recursive input: `or(append(channels[2:], orDone)...)`.

Whichever branch wins, this `select` closes `orDone` through `defer`. The recursive `select` then wakes through its `<-or(tail...)` branch.

That goroutine returns and exits. The same rule applies at every level. Each level's shutdown closes the levels below it.

The "divide-and-conquer" name is misleading. The code does not split the list in half.

It removes two channels, `channels[0]` and `channels[1]`. It combines the other N-2 channels with one new `orDone`.

The next level has N-1 channels, not N/2. This makes a linear chain with O(N) depth, not O(log N) depth.

The code creates N-1 goroutines for N channels. A binary tree with N leaves also has N-1 internal nodes.

This is the same order as Approach 1's N goroutines. It is not fewer.

The linear shape also adds delay. Suppose `channels[12]` of 20 fires.

The signal climbs one level at a time. Each level closes its `orDone`, wakes the level above, and exits.

The worst case is O(depth), which is O(N) wake-ups. Approaches 1 and 2 take O(1), because one goroutine closes the shared output directly.

You can split the list in half and recurse on each half: `or(or(left...), or(right...))`.

That lowers depth to O(log N) and keeps N-1 goroutines. It is the likely source of the "halving" idea.

This doc does not include it as a separate approach. It still has O(N) goroutines and more code. Its shallower depth does not matter for this exercise's small channel counts.

I tested this version in the same scratch copy. `go test -race -count=5 ./...` passed all five runs.

It found no data races. The runs covered 0, 1, and 20 channels.

## Key takeaways

- Watching only `channels[0]` is a common mistake. It passes tests that close only the first channel.
- `TestOrFiresOnFirstChannel` alone cannot catch the bug.
- The 0 and 1 channel cases are not just cleanup. A relay for one input leaks when that input never closes.
- A flat fan-out with `sync.Once` is the simplest correct design.
- All goroutines do the same job. There is no recursion and no orphan trap. The result reacts in one hop.
- Its only cost is O(N) goroutines instead of O(1).
- `reflect.Select` uses one goroutine and one flat N-way select. It reacts in one hop like Approach 1.
- Its cost is reflection and an allocation-heavy `[]reflect.SelectCase` on every call.
- The classic recursive idiom uses a constant two channels per level, not two halves.
- It forms a linear chain with O(N) depth, not a balanced tree with O(log N) depth.
- Recurse with `or(channels[2:]...)` unchanged, and the current level can orphan a goroutine.
- The current `select` can win on `channels[0]` or `channels[1]` instead of the recursive branch.
- Add this level's `orDone` with `or(append(channels[2:], orDone)...)` to fix that leak.
- A deep winner still needs O(N) wake-ups. Approaches 1 and 2 need O(1).
- The recursive form is useful for learning, not for speed.
- Do not use `testing/synctest` to test a hang. A goroutine that never wakes makes the bubble look deadlocked.
- `synctest` then panics and takes down the test binary.
- `TestOrFiresOnAnyChannel` and `TestOrHandlesManyChannels` use the real clock, `select`, and `time.After` for this reason.
