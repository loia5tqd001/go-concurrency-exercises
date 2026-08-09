# Future/Promise Pattern: Async, Memoized Computation

Given is a `Future` function that's supposed to represent an
asynchronous, memoized, keyed computation: calling `Future(key)`
should kick off `ComputeExpensive` (see `mockcompute.go`) in the
background and return a channel immediately - receiving from that
channel blocks until the result is ready. Calling `Future` again for
the SAME key - whether the first call is still in flight, or its
result has long since been cached, and no matter how many goroutines
call it at once - must never trigger a second call to
`ComputeExpensive` for that key; every caller gets a channel that
delivers the same result.

Right now `Future` is not async at all - it calls `ComputeExpensive`
synchronously, on the calling goroutine, before returning - so calling
`Future` blocks the caller for the full 150ms up front, defeating the
entire point of a future (you can't do other work while it's
computing). It also recomputes from scratch on every single call, even
for a key it has already computed before.

Your task is to fix `Future` so that:

- `Future(key string) <-chan int` kicks off `ComputeExpensive(key)` in
  its own goroutine and returns a channel near-instantly, instead of
  blocking the caller.
- The returned channel delivers exactly one value: the result for
  `key`. Receiving from it blocks until that result is ready.
- Calling `Future(key)` again for a key that's already in flight or
  already cached always returns a channel that delivers the same
  result, and never triggers another call to `ComputeExpensive` for
  that key.

The signature must stay the same:

```go
func Future(key string) <-chan int
```

## Why a channel, not a `Future` struct with `Get()`?

An earlier version of this exercise had you build a `Future` type with
`NewFuture(key) *Future` / `(*Future).Get() int` - the classic
Java/JS-style Future object. That's a fine teaching device in
languages built around that idiom, but it's not how Go itself reaches
for this problem: Go already has a first-class primitive for "an
async result you'll receive later" - a channel. Returning
`<-chan int` directly, instead of wrapping it in a bespoke object with
a blocking getter, is the more idiomatic shape, and it's what you'll
see in real Go code (worker results, fan-in stages, `context.Done()`)
far more often than a hand-rolled `Future` class.

The other half of this exercise - "many concurrent callers, one
computation, cached forever" - has a well-known idiomatic Go answer
too: it's exactly what [`sync.OnceValue`](https://pkg.go.dev/sync#OnceValue)
is for (compute a value exactly once, safely share it across any
number of concurrent callers, cache the result forever), combined with
a small mutex-guarded map to pick the right memoized computation for
each `key`. If you get stuck, that's the pair of building blocks to
reach for. The production-grade version of this whole pattern - dedupe
concurrent identical work by key, without necessarily caching forever
- already exists in the wild as
[`golang.org/x/sync/singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight);
worth knowing about even though this exercise has you build a tiny
piece of it by hand.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
