# Or-Channel Combinator: Combining Independent Shutdown Triggers

A service often needs to shut down as soon as ANY of several
independent triggers fires — a failed health check, an
admin-requested shutdown, a deadline expiring, ... Each trigger is
naturally its own `<-chan struct{}` that gets closed the moment its
condition occurs. `or` combines an arbitrary, variadic number of such
signal channels into a single channel a caller can select on.

```
today (broken):                      goal:
channels[0] ──▶ watched                channels[0] ─┐
channels[1] ···  ignored                channels[1] ─┼─▶ combined closes
channels[2] ···  ignored                channels[2] ─┘   the instant ANY
(closing 1 or 2 does nothing)                            one of them closes
```

Right now `or` only ever watches `channels[0]`. Closing any channel
OTHER than `channels[0]` has no effect on the returned channel at all
— it just sits there, blocked forever, even though one of the
shutdown triggers already fired.

## Your task

Fix `or` so the returned channel closes as soon as ANY of the input
channels closes:

- With zero input channels, there's nothing to wait on — return a
  channel that's never closed.
- With exactly one input channel, closing it must close the combined
  channel promptly, without leaving behind a goroutine that outlives
  the call when that one channel never closes (the normal case for
  one of several independent triggers that doesn't end up firing).
- With more than one input channel, the combined channel must close
  the instant ANY of them closes — no matter which one, and no matter
  how many there are.

Signature stays the same:

```go
func or(channels ...<-chan struct{}) <-chan struct{}
```

## Test your solution

```
go test
go test --race
```
