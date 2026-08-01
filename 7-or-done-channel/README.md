# Or-Done Channel: Stopping a Long-Lived Monitoring Feed Cleanly

Given is a function `StartMetricStream` (see `mockmonitor.go`) that
simulates a monitoring agent: it spawns a goroutine that emits one
metric reading every 20ms, forever, on the channel it returns. It's a
long-lived feed - think of a metrics websocket or a tailed log - so it
has no way of knowing when the consumer has stopped caring about new
values, and it never closes its channel on its own.

`orDone` is meant to let a consumer stop reading from such a feed
early, via a `done` channel, without leaking the goroutine that
forwards values, and without every read site having to litter itself
with a done-aware `select`. Right now it doesn't do that at all - it
just hands back the input channel unchanged, so closing `done` has no
effect on it whatsoever: nothing ever stops a producer from blocking
forever trying to send a value that nobody will read again.

Your task is to implement `orDone` properly. It must spawn its own
goroutine that ranges over the input channel, forwarding each value
onto a new output channel it returns. Both things that goroutine does
- receiving the next value, and sending the forwarded value onward -
can block forever if the other side has walked away, so each must be
a `select` that also watches `done`. As soon as `done` is closed, the
goroutine must return promptly (closing the output channel behind it)
instead of blocking forever on a send nobody will read or a receive
that may never come. The function signature must stay the same:

```go
func orDone(done <-chan struct{}, c <-chan int) <-chan int
```

so that it remains a drop-in replacement for the passthrough version
below.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
