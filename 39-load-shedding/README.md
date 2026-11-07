# Load Shedding: Reject Fast Instead of Blocking the Hot Path

`Queue` is a fixed-size worker pool. It processes `Job`s sent with
`Submit`. Think of a telemetry client. Each request calls `Submit` to
record a metric. A background pool groups and sends the metrics. This
continues while the process runs. One rule is strict: recording a
metric must not slow the request.

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

Today, `Submit` does a blocking send on a bounded channel. When the
channel and every worker are full, the next `Submit` waits. It waits
for something to free up. This is not a deadlock because workers are
still draining. But it is exactly what a hot path cannot do. The caller
does not know how long the wait will last. Every millisecond of waiting
delays the real request.

## Your task

Make `Submit` fail fast. When `jobs` has no room, return
`ErrOverloaded` at once. Never wait for room.

Keep the exported surface the same:

```go
func NewQueue(workers, capacity int) *Queue
func (q *Queue) Submit(job Job) error
```

You should not need to change `Job` or `worker`.

## Contrast with 18's backpressure

[18](../18-bounded-pipeline-backpressure) is the mirror image. There,
the producer is supposed to feel the slowdown. Blocking is correct.
Here, the caller has a better option when the queue is full. It can
drop the metric, retry on a cheaper path, or degrade. Blocking is
wrong.

Both exercises use a bounded channel and a fixed worker pool. The
full-queue answer is opposite. The right answer depends on whether the
caller should wait.

## Hint, if you're stuck

```go
select {
case ch <- v:
	// sent
default:
	// nobody was ready RIGHT NOW - do this instead
}
```

`select` with `default` tries the send once. If the channel cannot
accept the send right now, `default` runs. It does not wait. This is
the standard try-without-waiting idiom.

## Test your solution

```
go test
go test --race
```
