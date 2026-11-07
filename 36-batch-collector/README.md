# Batch Collector: A Reusable Batcher With a Deadline and a Real Shutdown

`Collector` combines requests from many concurrent callers. Each caller
gets its own result. The batch API is called once per batch. The
collector keeps running. Real batching clients work this way. Examples
include a Kafka producer's `linger.ms`, a Google Pub/Sub publisher's
`DelayThreshold`/`CountThreshold`, and Segment's analytics client:

```
Add(order 0) ─┐
Add(order 1) ─┼─▶ buffer requests ──MaxBatchSize-th Add, OR───▶ fn(batch) ── fires,
Add(order 2) ─┘    MaxWait elapses since the batch's 1st Add   then a fresh
                                       fan back out, each caller  batch opens
                                       gets its own matching
                                       response
```

Picture 30 goroutines. Each needs a shipping quote for its own order.
The quoting API accepts a batch. It returns N quotes for N orders. It
charges one full round trip per call, whatever the batch size. The
service keeps running.

One batched call per burst is efficient. But the goroutines do not know
about each other. They do not know when a batch is full. Traffic may go
quiet with a short batch. Still, every caller needs an answer within a
bounded wait. The collector must batch a full or partial set.

At shutdown, the collector must stop new orders. It must finish queued
work. It must report when everything is done. It must not drop requests
or hang.

Today, `Collector` does not batch anything:

- `Add` calls `fn` at once. It sends a "batch" with only its one request.
  The core idea, combining callers into one round trip, does not exist.
- `Config` accepts `MaxBatchSize` and `MaxWait`. The code never reads
  them.
- `Close` returns `nil` at once. It still accepts requests, fires
  nothing, and waits for nothing.

## Your task

Fix `Collector` so that:

- `Add(request int) <-chan Result` adds `request` to the current open
  batch. It returns a channel. That channel receives exactly one
  `Result` when the batch runs.
- `Add` must be safe for concurrent calls from any number of goroutines.
  This lasts until the collector closes.
- Normally, a batch fires when one of two triggers wins. The triggers
  are reaching `MaxBatchSize` or waiting `MaxWait` since its first
  request. It then runs `fn` once, with all requests so far, in call
  order. Each batch must call `fn` exactly once. Never zero, never
  twice.
- When a batch fires, a fresh batch opens at once. This continues for
  as many batches as callers submit. Each caller gets the result at the
  index of its own request. It must not get another caller's result or
  another batch's result.
- If `fn` errors, every caller in that batch gets that same error.
- `Close(ctx) error` stops new `Add` calls. Each later call returns
  `ErrCollectorClosed` at once. `Close` fires the queued requests as one
  last partial batch. It does not discard them. It waits until every
  started batch has finished calling `fn`. If `ctx` ends first, it
  returns `ctx`'s error. This matches `net/http`'s
  [`Server.Shutdown(ctx)`](https://pkg.go.dev/net/http#Server.Shutdown).
- `Close` must be safe for repeated calls. It must also be safe when
  called at the same time as `Add` or another `Close`.

Keep the signatures the same:

```go
func NewCollector(cfg Config, fn BatchFunc) *Collector
func (c *Collector) Add(request int) <-chan Result
func (c *Collector) Close(ctx context.Context) error
```

## The double-fire trap

A batch can fire from three triggers. The count reaches `MaxBatchSize`;
the batch timer reaches `MaxWait`; or `Close` runs. All three must
agree. The first wins, and `fn` runs once for that batch. Two triggers
may see the same batch as ready. Both may fire it. That is the
double-fire bug. Here there are three paths, not one:

```
Add pushes count to MaxBatchSize ──┐
batch's MaxWait timer fires  ──────┼──▶  EXACTLY ONE of these may ever
Close is called            ────────┘     call fn for this one batch
```

`time.Timer.Stop()` does **not** guarantee its function has not started.
Calling `Stop()` when the count fires is not enough. The timer callback
may still run at the same time. Any check for "already fired" must work
when both paths are live. It cannot rely on them running one after the
other.

## Rolling to the next batch

After one batch fires, `Add` must fill a new one. This repeats forever.
A trigger must detach its own batch from the current one. It must not
affect a newer batch that opened in the meantime. A stale timer for an
old batch must not reset or corrupt the new batch.

## Close: a hazard worth building a test for

`Close` must know when every batch has finished. It must never see zero
batches in flight while a just-started batch is not counted. That can
happen from a concurrent `Add` or a timer that fired moments earlier.
`go test -race` catches this ordering bug. A test must force the two
paths to race.

## Test your solution

```
go test
go test --race
```
