# Load Balancer: Self-Scheduling Workers That Report Their Own Load

This exercise follows Rob Pike's 2012 Go Concurrency Patterns talk. A
`Pool` holds `Worker`s in a min-heap ordered by `pending`, the current
load. `heap.Pop(&pool)` returns the least loaded `Worker` at that moment.

```
                dispatch: heap.Pop → least-loaded Worker
       ┌──────────────────────────────────────────────┐
       ▼                                              │
work ─▶ Balance ◀──────────── done ◀──── Worker.work ─┘
         (pool: min-heap by pending)      (runs req, then
                                           reports itself
                                           back on done)
```

`Worker.work` is already correct. Do not change it. It runs one request
at a time from its own inbox. It then sends itself on `done` to report
that it is free.

## The bug

`Balance` only listens on `work`. It never reads `b.done`:

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}
```

That is invisible at first. With up to `numWorkers` fresh workers,
nobody needs `done` yet. The loop wedges when a request goes to a
`Worker` that has already finished a job.

```
Worker finishes 1st request ──▶ done <- w blocks forever (nobody's listening)
                                          │
Balance later dispatches a 2nd request to that same Worker:
    w.requests <- req ──▶ blocks forever (Worker never comes back to receive)
                                          │
        Balance's ONE goroutine is now stuck on that send
                                          │
      every later request queued behind it in `work` waits forever too
```

## Your task

> **Heads up:** this exercise also tests `container/heap` at usage level,
> not just concurrency. "Updates the pool accordingly" means calling
> `heap.Fix` on the `Worker` whose load changed. Do not use `Pop`+`Push`,
> and do not change `Pool`'s methods. If `heap.Fix` is new, read
> [`container/heap`'s docs](https://pkg.go.dev/container/heap). You are
> using the heap, not rebuilding one.

Fix `Balance` so it also drains `b.done` and updates the pool. Keep the
exported surface the same:

```go
func NewBalancer(numWorkers int) *Balancer
func (b *Balancer) Balance(work <-chan Request)
```

You should not need to change `Request`, `Worker`, or `Pool`.

## A note on `requestBacklogPerWorker`

`requestBacklogPerWorker` is not just a speed setting. Correctness
depends on it. Its value (`16`) fits this exercise's traffic. That
traffic is a burst a few times larger than `numWorkers`. The value is
not derived from another rule.

Make the buffer small enough for one `Worker`'s load, and the fixed
`Balance` wedges again. This has the same shape as
[the bug](#the-bug) you are fixing. `Balance` sends with
`w.requests <- req` inside its only goroutine. If a `Worker`'s buffer
is full, that send blocks. `Balance` cannot reach its `done` case for
any `Worker`. This is not limited to the blocked `Worker`.

At `requestBacklogPerWorker = 0`, the original wedge returns. It happens
on the first request to a `Worker` that is not idle. See
[33b](../33b-load-balancer-nonblocking-dispatch) for a direct sequel.
That exercise removes the buffer and asks for a correct `Balance`
without one.

## Test your solution

```
go test
go test --race
```
