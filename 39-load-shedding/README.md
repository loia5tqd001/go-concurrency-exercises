# Load Shedding: Reject Fast Instead of Blocking the Hot Path

`Queue` is a small, fixed-size pool of workers that process `Job`s
handed to it via `Submit` - think an application's telemetry client:
every request calls `Submit` to record a metric, a background pool
aggregates and ships them somewhere, and this keeps happening for as
long as the process is up. The one hard rule: recording a metric must
never slow down the request that triggered it.

```
today:  Submit(job) ──▶ jobs <- job ──▶ blocks until a worker frees up
                                          (the REQUEST waits on the
                                           METRIC - backwards)

goal:   Submit(job) ──▶ room right now? ──yes──▶ queued, returns instantly
                              │
                              no
                              ▼
                         return ErrOverloaded instantly - caller drops
                         the metric and moves on, unslowed
```

Right now `Submit` is a plain blocking send on a bounded channel. Once
that channel and every worker are full, the next `Submit` call just
sits there waiting for *something* to free up. Not a deadlock - the
workers are still draining - but exactly the failure mode a hot-path
caller can't afford: it has no idea how long "briefly busy" is going
to last, and every millisecond it waits is a millisecond stolen from
the actual request it's supposed to be serving.

## Your task

Make `Submit` fail fast: the instant `jobs` has no room, return
`ErrOverloaded` immediately - never block waiting for space to free
up.

Exported surface stays the same:

```go
func NewQueue(workers, capacity int) *Queue
func (q *Queue) Submit(job Job) error
```

You should not need to change `Job` or `worker`.

## Contrast with 18's backpressure

[18](../18-bounded-pipeline-backpressure) is the mirror image of this
exercise: there, the producer is *supposed* to feel the slowdown, so
blocking is the right answer. Here, the caller has somewhere better to
go the instant it can't get in - drop the metric, retry a cheaper
path, degrade gracefully - so blocking is exactly wrong. Same shape of
problem (a bounded channel backed by a fixed pool of workers), opposite
answer to "what happens when it's full?" - which one is correct
depends entirely on whether the caller is meant to wait.

## Hint, if you're stuck

```go
select {
case ch <- v:
	// sent
default:
	// nobody was ready RIGHT NOW - do this instead
}
```

`select` + `default` tries the send once; if nothing's ready this
instant, `default` runs instead of waiting - the standard idiom for
"try, don't wait."

## Test your solution

```
go test
go test --race
```
