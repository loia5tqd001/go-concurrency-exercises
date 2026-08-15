# Batch Collector: Coalescing N Concurrent Calls Into One Batch API Request

`Collector` lets many independent, concurrent callers each get back
their own result from a batch API, while the API itself only ever gets
called **once**:

```
Add(order 0) ─┐
Add(order 1) ─┼─▶ Collector buffers requests ──expected-th Add──▶ fn(all requests) ── once
Add(order 2) ─┘                                                        │
                                                    fan back out, each caller gets
                                                    its own matching response
```

Picture 30 goroutines each needing a shipping quote for their own
order, calling a quoting API that supports batches (send N orders, get
N quotes) but charges a full round-trip per call regardless of size.
30 separate calls waste 29 round-trips; one batched call is the
efficient move — but the 30 goroutines don't know about each other,
don't know when the 30th shows up, and each still needs exactly its
own quote back.

Right now `Add` mutates two shared slices and a shared counter with
**zero synchronization**, from however many goroutines call it. That
fails in three ways depending on scheduling luck:

- Lost increments on `nQueued` → the fire condition is never reached →
  `fn` never runs → every caller blocks forever.
- Concurrent unsynchronized appends to `c.requests`/`c.resultChs` can
  corrupt both slices outright.
- `go test -race` flags it regardless of whether either failure above
  happens to manifest on a given run.

## Your task

Fix `Collector` so that:

- `Add(request int) <-chan Result` registers `request` and returns a
  channel that receives exactly one `Result` once the batch runs.
- `Add` is safe to call concurrently, from any number of goroutines.
- `fn` runs **exactly once**, the moment the `expected`-th `Add`
  arrives, with every request added so far, in call order.
- Each caller gets back the response matching **its own** request's
  position — not some other caller's.
- If `fn` errors, every caller in the batch gets that same error.

Signature stays the same:

```go
func (c *Collector) Add(request int) <-chan Result
```

## A trap worth calling out

A mutex around the appends and the counter is necessary but not
sufficient. Lock-mutate-unlock, *then* check "did I just push the
count to `expected`?" leaves a gap:

```
goroutine A: nQueued++ (now == expected)         goroutine B: nQueued++ (still == expected)
      │  unlock                                        │  unlock
      ▼                                                 ▼
  reads nQueued >= expected → true              reads nQueued >= expected → true
      │                                                 │
      ▼                                                 ▼
  calls fn()  ◀──────────────  BOTH think they're the one who should fire  ──────────────▶  calls fn()
```

Two goroutines can both observe "threshold reached" and both fire —
deciding exactly how to close that gap (hold the lock across the whole
call, or leave a flag behind that only lets one caller through) is the
interesting part of this exercise.

## Test your solution

```
go test
go test --race
```
