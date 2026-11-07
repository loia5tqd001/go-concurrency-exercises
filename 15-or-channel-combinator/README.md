# Or-Channel Combinator: Combining Independent Shutdown Triggers

A service may need to stop when any trigger fires. Examples include a
failed health check, an admin shutdown, or an expired deadline. Each
trigger can be its own `<-chan struct{}`. The channel closes when the
trigger fires. `or` combines any number of these channels into one
signal channel.

```
today (broken):                      goal:
channels[0] ──▶  watched               channels[0] ─┐
channels[1] ···  ignored               channels[1] ─┼─▶ combined closes
channels[2] ···  ignored               channels[2] ─┘   the instant ANY
(closing 1 or 2 does nothing)                           one of them closes
```

Today, `or` watches only `channels[0]`. Closing another channel has no
effect. The returned channel stays open even though a trigger fired.

## Your task

Fix `or` so the returned channel closes when any input channel closes:

- With no inputs, nothing can close the result. Return a channel that
  never closes.
- With one input, close the combined channel quickly when the input
  closes. If that input never closes, do not leave a goroutine behind.
- With many inputs, close the combined channel as soon as any one
  closes. This must work for every input and every count.

Signature stays the same:

```go
func or(channels ...<-chan struct{}) <-chan struct{}
```

## Test your solution

```
go test
go test --race
```
