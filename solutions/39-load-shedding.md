# Load Shedding: Reject Fast Instead of Blocking the Hot Path — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The problem

`Submit` uses a plain blocking send:

```go
func (q *Queue) Submit(job Job) error {
	q.jobs <- job
	return nil
}
```

`jobs` is a real bounded channel with capacity `capacity`. Once the
channel and every worker are busy, the send has nowhere to go.

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

The other two tests pass with the naive scaffold. This is the only
broken part. `check_test.go` catches it directly.

## The fix: `select` + `default`

```go {5,6}
func (q *Queue) Submit(job Job) error {
	select {
	case q.jobs <- job:
		return nil
	default:
		return ErrOverloaded
	}
}
```

`select` + `default` tries the send once, right away. If `jobs` has no
room *right now*, `default` runs instead of waiting. That is the whole
fix. The rest of `Queue` is the same worker-pool pattern as
[11](../11-worker-pool). It starts `workers` goroutines, and each reads
from one shared bounded channel. The exercise is about what `Submit`
does when the queue is full. It does not ask you to rebuild the pool.

**Verified**: `gofmt` and `vet` are clean. `go test -race -count=10`
passed 10 of 10 runs without flakes.

## Why blocking is wrong here specifically

[18](../18-bounded-pipeline-backpressure) uses the same shape. A
bounded channel feeds a fixed pool. It blocks the producer on purpose.
The difference is who calls `Submit`. In 18, the producer's job is to
feed the pipeline. Slowing it when the pipeline is full is correct
backpressure. Here, unrelated work calls `Submit`. Blocking it does not
reduce pressure on that work. It only makes the work slower for an
unrelated reason. This is not a better version of 18's mechanism. It is
a different answer to a different saturation case.

## Alternative: an atomic counter as the admission gate

The channel buffer is not the only way to check for room. A second
design tracks admitted jobs that are not finished yet. It uses an
`atomic.Int64` and a `CompareAndSwap` admission check. This is the same
check-then-act idea that [38](../38-settle-once) teaches.

```go {10,13,24}
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

This is a real tradeoff, not a rename of the same idea.

- **Channel capacity:** The channel-buffer version uses the buffer size
  as capacity. It is simple. The buffer does the queueing. No other
  state needs to stay in sync.
- **Separate admission:** The counter version separates logical
  admission from channel buffer size. This helps when admission covers
  more than one channel or resource. It also lets you reject before
  building a possibly expensive `Job` value. The cost is a second
  piece of state, `inFlight`. Every admission path must eventually
  decrement it exactly once. The channel version gets this from the
  channel.

For this exercise, use one queue and one resource. Nothing expensive is
built before enqueue. `select`+`default` is simpler and more idiomatic.
That is why `main.go` is scaffolded around it. The counter version is
useful when admission control must cover more than one channel's
buffer.

## Key takeaways

- `select`+`default` asks whether anyone is ready for this send right
  now. It is the standard "try, do not wait" idiom.
- A bounded queue with fail-fast rejection is not always better than
  blocking, as in 18. It trades a possible wait for a possible failure.
  It wins only when the caller can use that failure well.
- One bounded channel feeding a fixed worker pool can need opposite
  behavior when full. It depends on whether the caller should feel the
  slowdown.
