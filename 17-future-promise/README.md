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

```
Today: Future computes inline on the caller's goroutine, every call
  caller 1 ──▶ Future(key) ──▶ ComputeExpensive 150ms ──▶ ch
  caller 2 ──▶ Future(key) ──▶ ComputeExpensive 150ms ──▶ ch
  caller 3 ──▶ Future(key) ──▶ ComputeExpensive 150ms ──▶ ch
  each caller blocks 150ms before its channel arrives; 3 computations

Goal: Future returns each channel at once; one computation per key
  caller 1 ─┐                      ┌─▶ ch1 (cap 1, one int)
  caller 2 ─┼─▶ Future(key) ───────┼─▶ ch2 (cap 1, one int)
  caller 3 ─┘  (returns at once)   └─▶ ch3 (cap 1, one int)
                    │
                    ▼
   one ComputeExpensive run (150ms), cached for later calls; all
   three channels deliver the same int
```

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

The hard part is coordinating two lifetimes at once: the in-flight
computation is shared while callers overlap, then its result is cached
for every later caller. Work out how to keep those transitions safe
without serializing unrelated keys. The worked solution compares the
standard-library building blocks and the production pattern after you
have tried your own design.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
