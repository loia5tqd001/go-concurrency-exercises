# Load Balancer: Self-Scheduling Workers That Report Their Own Load

Modeled on Rob Pike's 2012 "Go Concurrency Patterns" talk: a `Pool` of
`Worker`s kept as a min-heap ordered by `pending` (current load), so
`heap.Pop(&pool)` always hands back whichever `Worker` is least loaded
right now.

```
                dispatch: heap.Pop → least-loaded Worker
       ┌─────────────────────────────────────────────┐
       ▼                                              │
work ─▶ Balance ◀──────────── done ◀──── Worker.work ─┘
         (pool: min-heap by pending)      (runs req, then
                                            reports itself
                                            back on done)
```

`Worker.work` (already correct — do not touch) runs requests off its
own inbox one at a time, then sends itself on `done` to say "I just
freed up."

## The bug

`Balance`'s select loop only has a `work` case — it never reads
`b.done`:

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}
```

That's invisible for a first burst of up to `numWorkers` requests —
every `Worker` is fresh and nobody needs `done` yet. It wedges the
instant a request has to route to a `Worker` that already finished its
first job:

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

> **Heads up:** this one also tests `container/heap` at usage level, not
> just concurrency. "Updates the pool accordingly" means calling
> `heap.Fix` on the `Worker` that just changed load — not
> `Pop`+`Push`, and not touching `Pool`'s own methods. If `heap.Fix`
> is new to you, skim [`container/heap`'s
> docs](https://pkg.go.dev/container/heap) first; you're using the
> heap, not reimplementing one.

Fix `Balance` so it also drains `b.done` and updates the pool
accordingly. Exported surface stays the same:

```go
func NewBalancer(numWorkers int) *Balancer
func (b *Balancer) Balance(work <-chan Request)
```

You should not need to change `Request`, `Worker`, or `Pool`.

## Test your solution

```
go test
go test --race
```
