# Future/Promise Pattern: Async, Memoized Computation

`Future` should start an expensive computation and return at once.
Calling `Future(key)` should start `ComputeExpensive` (see
`mockcompute.go`) in the background and return a channel. Receiving
from the channel waits for the result.

Calling `Future` again for the same key must reuse the first call.
This applies while the first call is running and after it has cached
its result. Many goroutines may call it at once. They must all get
the same result without another `ComputeExpensive` call.

Today, `Future` does not run in the background. It calls
`ComputeExpensive` on the caller and returns only after 150ms. The
caller cannot do other work during that time. Every call also starts
a new computation.

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

Your task is to fix `Future`:

- `Future(key string) <-chan int` starts `ComputeExpensive(key)` in
  its own goroutine and returns a channel almost at once.
- The channel sends exactly one value: the result for `key`.
  Receiving from it waits until the result is ready.
- A later `Future(key)` call must reuse the running or cached result.
  It must not call `ComputeExpensive` again for that key.

The signature must stay the same:

```go
func Future(key string) <-chan int
```

## Why a channel, not a `Future` struct with `Get()`?

An earlier version of this exercise used a `Future` type. It had
`NewFuture(key) *Future` and `(*Future).Get() int`. That Java/JS-style
object works in languages built around it.

Go already has a channel that can deliver a result later. Returning a
`<-chan int` is simpler than wrapping it in a custom object with a
blocking getter. Real Go code uses channels for worker results, fan-in
stages, and `context.Done()`. It rarely uses a hand-made Future type.

The hard part is sharing one running computation, then caching its
result. Keep those state changes safe. Do not block unrelated keys.
After you try your design, the solution compares standard-library
building blocks and the production pattern.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
