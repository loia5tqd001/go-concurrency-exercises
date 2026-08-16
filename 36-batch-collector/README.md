# Batch Collector: A Reusable Batcher With a Deadline and a Real Shutdown

`Collector` lets many independent, concurrent callers each get back
their own result from a batch API, while the API itself only gets
called once per batch - and it keeps doing this indefinitely, the way
a real batching client (a Kafka producer's `linger.ms`, a Google
Pub/Sub publisher's `DelayThreshold`/`CountThreshold`, Segment's
analytics client) actually runs in production, not just once and done:

```
Add(order 0) ─┐
Add(order 1) ─┼─▶ buffer requests ──MaxBatchSize-th Add, OR───▶ fn(batch) ── fires,
Add(order 2) ─┘    MaxWait elapses since the batch's 1st Add   then a fresh
                                       fan back out, each caller  batch opens
                                       gets its own matching
                                       response
```

Picture 30 goroutines each needing a shipping quote for their own
order, from a quoting API that supports batches (send N orders, get N
quotes) but charges a full round-trip per call regardless of size -
and this keeps happening for as long as the service is up, not just
once. One batched call per burst is the efficient move - but the
goroutines don't know about each other, don't know when a batch is
"full," and a batch that's still short when traffic goes quiet can't
just wait forever either: every caller needs an answer within some
bounded latency, full batch or not. And when the process is shutting
down, it needs to stop taking new orders, finish whatever's already
queued, and say so - not silently drop requests or hang forever.

Right now `Collector` doesn't batch anything at all:

- `Add` calls `fn` immediately, with a "batch" of exactly the one
  request it was given - the entire "coalesce many callers into one
  round-trip" idea this exercise is about doesn't exist yet.
- `MaxBatchSize` and `MaxWait` are both accepted in `Config` and never
  looked at.
- `Close` returns `nil` immediately. It doesn't stop `Add` from still
  accepting requests, doesn't fire anything, and doesn't wait for
  anything.

## Your task

Fix `Collector` so that:

- `Add(request int) <-chan Result` registers `request` as part of
  whichever batch is currently open and returns a channel that
  receives exactly one `Result` once that batch runs.
- `Add` is safe to call concurrently, from any number of goroutines,
  for as long as the `Collector` hasn't been closed.
- A batch fires - runs `fn` exactly once, with every request queued
  into it so far, in call order - the moment **either** its
  `MaxBatchSize`-th request arrives **or** `MaxWait` has elapsed since
  its first request, whichever happens first. Whichever trigger wins,
  `fn` must run exactly once for that batch - never zero, never twice.
- The instant one batch fires, the `Collector` opens a fresh one and
  keeps working indefinitely, for as many batches as callers keep
  submitting. Every caller gets back the `Result` at `fn`'s response
  index matching the position **its own** request ended up at in
  **its own** batch - never another caller's, and never a different
  batch's.
- If `fn` errors, every caller in that batch gets that same error.
- `Close(ctx) error` stops the `Collector` from accepting any further
  `Add` calls (each gets `ErrCollectorClosed` immediately instead),
  fires whatever's currently queued as one last partial batch instead
  of abandoning it, and blocks until every batch it ever started has
  actually finished running `fn` - or returns `ctx`'s error if `ctx` is
  done first, the same shape as `net/http`'s own
  [`Server.Shutdown(ctx)`](https://pkg.go.dev/net/http#Server.Shutdown).
  `Close` is safe to call more than once, and concurrently with `Add`
  and with itself.

Signatures stay the same:

```go
func NewCollector(cfg Config, fn BatchFunc) *Collector
func (c *Collector) Add(request int) <-chan Result
func (c *Collector) Close(ctx context.Context) error
```

## The double-fire trap

A batch can be fired by whichever of **three** things happens first:
its count trigger, its own deadline timer, or `Close`. All three must
agree on "whoever gets there first, exactly once" - two of them
racing to observe "this batch just reached its trigger" and both
firing is the classic version of this bug, and here there are three
ways to reach it instead of one:

```
Add pushes count to MaxBatchSize ──┐
batch's MaxWait timer fires  ──────┼──▶  EXACTLY ONE of these may ever
Close is called            ────────┘      call fn for this one batch
```

Worth trusting less than it looks like: `time.Timer.Stop()` does
**not** guarantee its function hasn't already started running. Calling
`Stop()` the moment the count trigger fires does not, by itself,
prevent that batch's deadline timer from *also* calling its callback
concurrently a moment later - whatever decides "has this batch already
fired" has to hold up even when the count path and the timer path are
both live at once, not just when they're neatly sequential.

## Rolling to the next batch

Once one batch fires, `Add` needs to start filling a *new* one -
forever, not just once. Whichever trigger fires a batch has to detach
*that specific batch* from "the currently open one" without disturbing
whatever batch may already be open by the time the trigger gets around
to firing: a stale deadline timer belonging to a batch that already
fired by count must not be able to reset or corrupt whatever *new*
batch has opened in the meantime.

## Close: a hazard worth building a test for

Whatever mechanism `Close` uses to know "every batch has finished"
must never be able to observe zero batches in flight while a batch
that *just* started firing (from a concurrent `Add`, or a timer that
fired moments earlier) hasn't been counted yet. `go test -race` catches
exactly this ordering bug - but only if a test actually forces the two
to race concurrently, which is worth building deliberately.

## Test your solution

```
go test
go test --race
```
