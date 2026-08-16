# Load Shedding: Reject Fast Instead of Blocking the Hot Path — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

`Submit` is a plain blocking send:

```go
func (q *Queue) Submit(job Job) error {
	q.jobs <- job
	return nil
}
```

`jobs` is a real bounded channel (capacity `capacity`). Once it and
every worker are all busy, this send has nowhere to go:

```
jobs: FULL, every worker: busy
next Submit(job) ──▶ q.jobs <- job ──▶ blocks (not a deadlock - workers
                       are still draining - but indistinguishable from
                       one to the caller: no result, no error, no way
                       to know whether to keep waiting)
```

**Verified**:

```
=== RUN   TestSubmitFailsFastWhenQueueIsFull
    check_test.go:98: Submit attempt 3 blocked for over 200ms instead of failing fast - looks like it's still a blocking send instead of select/default
--- FAIL: TestSubmitFailsFastWhenQueueIsFull (0.20s)
```

The other two tests pass against the naive scaffold — this is the only
thing broken, and check_test.go catches exactly that.

## The fix: `select` + `default`

```go
func (q *Queue) Submit(job Job) error {
	select {
	case q.jobs <- job:
		return nil
	default:
		return ErrOverloaded
	}
}
```

`select` + `default` tries the send once, immediately; if `jobs` has no
room *right now*, `default` fires instead of waiting. That's the whole
fix — the rest of `Queue` (spawn `workers` goroutines, each pulling off
one shared bounded channel) is the same pattern [11](../11-worker-pool)
already teaches, reused here rather than re-derived, since this
exercise's lesson is specifically about what `Submit` does when the
queue's full, not about how to build a worker pool.

**Verified**: `gofmt`/`vet` clean, `go test -race -count=10` passes
10/10 with no flakes.

## Why blocking is wrong here specifically

[18](../18-bounded-pipeline-backpressure) uses the exact same shape — a
bounded channel feeding a fixed pool of consumers — and blocks the
producer on purpose. The difference is who's on the other end of
`Submit`. In 18, the producer's whole job *is* to feed the pipeline, so
slowing it down when the pipeline is full is the correct, intended
backpressure. Here, `Submit` is called from the middle of unrelated
work (the thing actually being measured) — blocking it doesn't relieve
any pressure, it just makes the real work slower for a reason that has
nothing to do with the real work. The fix isn't "the mechanism 18 uses,
done better" - it's a fundamentally different answer to "what should
happen when a bounded queue is full," each correct for its own kind of
caller.

## Alternative: an atomic counter as the admission gate

The channel's own buffer isn't the only way to answer "is there room
right now?" A second, genuinely different design tracks admitted-but-
not-yet-finished jobs with an `atomic.Int64` and a
`CompareAndSwap`-based admission check — the same idiom
[38](../38-flash-sale-inventory) teaches for check-then-act races on a
plain counter:

```go
type Queue struct {
	jobs     chan Job
	capacity int64
	inFlight atomic.Int64
}

func (q *Queue) Submit(job Job) error {
	for {
		cur := q.inFlight.Load()
		if cur >= q.capacity {
			return ErrOverloaded
		}
		if q.inFlight.CompareAndSwap(cur, cur+1) {
			break
		}
	}
	q.jobs <- job // unbounded/generously-buffered channel; the counter is the real gate
	return nil
}

func (q *Queue) worker() {
	for job := range q.jobs {
		job.Result <- job.Run()
		q.inFlight.Add(-1)
	}
}
```

This is a real tradeoff, not a rename of the same idea:

- The channel-buffer version's capacity *is* the channel's buffer size
  - simple, and the buffer itself provides the queueing, with nothing
    else to keep in sync.
- The counter version decouples "how many are logically admitted" from
  "how big is the channel's buffer" — useful if admission needs to
  span more than one channel or resource, or if you want to reject
  *before* even constructing the (possibly expensive) `Job` value being
  enqueued, rather than after. The cost is a second piece of state
  (`inFlight`) that must be kept consistent with reality — every path
  that admits a job must eventually decrement it exactly once, which
  the channel-buffer version gets for free from the channel itself.

For this exercise's shape — one queue, one resource, nothing to
construct before enqueuing — `select`+`default` is the simpler, more
idiomatic answer, which is why it's the one `main.go` is scaffolded
around. The counter version is worth knowing as the pattern to reach
for once admission control needs to answer to more than a single
channel's buffer.

## Key takeaways

- `select`+`default` answers "is anyone ready for this send *right
  now*?" — the standard idiom for "try, don't wait."
- A bounded queue plus fail-fast rejection isn't a strict improvement
  over blocking (18's approach) — it trades "the caller might wait"
  for "the caller might have to handle failure," which only wins when
  the caller has somewhere better to go with that failure.
- The same "bounded channel feeding a fixed worker pool" shape can
  correctly demand opposite behavior on saturation, depending entirely
  on whether the caller is meant to feel the slowdown.
