# Batch Collector: Coalescing N Concurrent Calls Into One Batch API Request

Given is a `Collector` meant to let many independent, concurrent
callers each get back their own result from a batch API, while the
API itself only ever gets called **once** per batch.

Picture 30 goroutines that each need a shipping quote for their own
order, calling a quoting API that supports batch requests (send N
orders, get N quotes back) but charges a full round-trip for every
call, batch size notwithstanding. Calling it once per order wastes 29
of those round-trips. Calling it once with all 30 orders is the
efficient move - but the 30 goroutines don't know about each other,
don't know when the 30th one shows up, and each still needs to get
back exactly its own quote, not the whole batch's worth, or someone
else's.

`Collector` is supposed to make that easy: each goroutine calls `Add`
with its own request and receives a channel; the moment the
`expected`-th request arrives, `Collector` calls the batch function
exactly once with everything collected so far, and delivers each
response back through its matching caller's channel.

Right now `Collector` does none of this safely. `Add` mutates two
shared slices and a shared counter with **no synchronization
whatsoever**, from however many goroutines call it concurrently. That
is not merely "a bit racy" - it can fail in three different ways
depending on scheduling luck:

- Lost increments on `nQueued` can mean the batch's fire condition is
  never reached at all, so `fn` never runs and every caller's channel
  blocks forever.
- Concurrent, unsynchronized appends to `c.requests` and
  `c.resultChs` can corrupt both slices outright.
- `go test -race` will flag the whole thing regardless of whether
  either of the above happens to manifest on a given run.

Your task is to fix `Collector` so that:

- `Add(request int) <-chan Result` registers `request` as part of the
  batch and returns a channel that will receive exactly one `Result`
  once the whole batch has run.
- `Add` is safe to call concurrently, from any number of goroutines.
- `fn` runs **exactly once**, only once the `expected`-th call to
  `Add` has arrived, with every request added so far, in the order
  `Add` was called for each of them.
- Every caller receives back the response at the index matching where
  **its own** request ended up in that slice - not some other
  caller's result.
- If `fn` returns an error, every caller in the batch receives that
  same error instead of a value.

The signature must stay the same:

```go
func (c *Collector) Add(request int) <-chan Result
```

## A trap worth calling out

Wrapping `nQueued++` and the two appends in a mutex is necessary, but
it is not sufficient by itself. If you lock just long enough to update
that shared state, unlock, and only then check "did I just push the
count to `expected`? if so, call `fn`" - two goroutines can both
observe the reached-threshold condition and both decide they're the
one who should fire, calling `fn` twice for the same batch. Exactly
what to do about that (hold the lock across the whole batch call, or
release it but leave a flag behind that only lets one caller through)
is the interesting part of this exercise.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
