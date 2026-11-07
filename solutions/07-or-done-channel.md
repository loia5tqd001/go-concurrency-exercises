# Or-Done Channel: Stopping a Long-Lived Monitoring Feed Cleanly — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `07-or-done-channel/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`StartMetricStream` in `mockmonitor.go` simulates a long-running feed.
It starts a goroutine. The goroutine sleeps for `MetricInterval`, 20ms.
It sends the next counter value and repeats forever. The output channel
never closes. A real feed has no way to know when the consumer leaves.

`orDone` sits between the feed and the consumer. The consumer can stop
early with a `done` channel:

```go
func orDone(done <-chan struct{}, c <-chan int) <-chan int
```

The starting version passes the input through unchanged:

```go
func orDone(done <-chan struct{}, c <-chan int) <-chan int {
	return c
}
```

Closing `done` has no effect. The returned channel is the input channel.

## Why the naive version is wrong

`orDone` returns `c` directly. Nothing checks `done`. There is no
forwarding goroutine to select on it. The consumer cannot signal
`orDone`.

The tests show the problem. `orDoneStopsPromptly` passes `orDone` a
channel `c` that never receives a value. A read blocks forever unless
`orDone` watches `done`. Here, `out` is `c`. Closing `done` does nothing.
The read waits for the test's 100ms timeout:

```
--- FAIL: TestOrDoneStopsPromptlyOnDone (0.10s)
    check_test.go:85: orDone did not stop promptly after done was closed -
    the forwarding goroutine appears to be leaked, blocked forever on a
    receive/send that will never happen
```

This is the leak. Without a forwarding goroutine and a `select`, nothing
notices that `done` closed.

## Approach 1: Forwarding goroutine with a double `select`

The fix starts one goroutine. It forwards values from `c` to a new `out`
channel. It uses `select` at both points that can block forever:

```go {8,9,15,17}
func orDone(done <-chan struct{}, c <-chan int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for {
			select {
			case <-done:
				return
			case v, ok := <-c:
				if !ok {
					return
				}
				select {
				case out <- v:
				case <-done:
					return
				}
			}
		}
	}()

	return out
}
```

Why two selects:

- **A read from `c`** can block forever. The producer may stop, or may
  never send. The outer `select` also waits for `<-done`.
- **A send to `out`** can block forever. The consumer may stop reading.
  The inner `select` also waits for `<-done`.
- Use `defer` to call `close(out)` on every exit path. It runs when `c`
  closes or when `done` fires. A `for range` over `out` always ends.
  The `range` form is the same.

A tempting-looking but broken alternative is a single select inside a
`for range c` loop:

```go {2}
// BROKEN: only the send is done-aware
for v := range c {
	select {
	case out <- v:
	case <-done:
		return
	}
}
```

This forwards values while `c` sends. But `range c` does not check
`done`. If `c` never sends, as in `orDoneStopsPromptly`, the loop blocks.
This is the same failure as the passthrough. Both the read and the send
need a `select`.

The tests:

- `TestOrDoneForwardsValues`: `done` stays open. Values move from `c` to
  `out` unchanged and in order.
- `TestOrDoneStopsPromptlyOnDone` and `TestOrDoneNoGoroutineLeakRace`:
  closing `done` unblocks the current `select`. The goroutine returns and
  runs `close(out)`. The reader sees `ok == false` and does not hang.

There is only one common shape here. Start a forwarder, select on both
blocking points, and close `out` on exit. A second approach would only
rename the same code.

## Key takeaways

- A channel can block on a read or a send. A read can wait for a value.
  A send can wait for a reader. Check `done` in both places.
- `defer close(out)` makes the result safe to range over. Every exit path
  closes `out`.
- Use this pattern around a channel you cannot close or stop. Add a
  `done` check to every operation that can block.
