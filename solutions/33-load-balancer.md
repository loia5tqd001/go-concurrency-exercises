# Load Balancer: Self-Scheduling Workers That Report Their Own Load — Suggested Solutions

> **Spoiler warning.** This file contains a full worked solution for `33-load-balancer/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`Balancer` fans `Request`s out across a `Pool` of `Worker`s, kept as a
min-heap ordered by `pending` (how many requests each `Worker` is
currently carrying), so `heap.Pop(&pool)` always hands back whichever
`Worker` is least loaded right now. Each `Worker` runs its own
goroutine that executes requests off its own inbox one at a time and,
after each one, reports itself back on a shared `done` channel so the
`Balancer` learns it just freed up:

```go
func (w *Worker) work(done chan *Worker) {
	for req := range w.requests {
		req.c <- req.fn()
		done <- w
	}
}
```

The given `Balance` only does half its job:

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}
```

The task is to fix `Balance` so it also drains `b.done` and updates the
pool accordingly, while keeping `NewBalancer` and `Balance`'s
signatures exactly the same.

## Why the naive version is wrong

Nothing in `Balance`'s loop ever receives from `b.done`. For exactly as
many requests as there are `Worker`s, that's invisible — each gets its
own `Worker` on the first round of dispatch, and every one of them
finishes correctly, because a `Worker`'s *first* job never needed
`pending` to be re-checked. But look at what happens right after: the
`Worker` calls `done <- w`, and since nothing is listening on
`b.done`, that send blocks forever. The `Worker`'s goroutine is now
permanently stuck one line before it would loop back to accept a
second request.

The moment a request has to route to a `Worker` that's already
finished its first job — which happens as soon as more requests have
arrived than there are `Worker`s — `dispatch`'s buffered send to that
`Worker`'s inbox still succeeds (the given code sizes it generously
enough that queuing doesn't itself block), but the request just sits
there forever, because the `Worker` that would eventually drain it is
wedged on `done <- w`:

```
--- FAIL: TestBalancerSurvivesMoreRequestsThanWorkers (2.00s)
    check_test.go:109: request 6 never completed
    check_test.go:130: request 6 result = 0, want 7
    ...
```

This is exactly the risk a real self-scheduling worker pool runs in
production: it looks completely correct under light load — one request
per backend, no queuing — and only wedges once traffic actually
exceeds the pool's size, which is the one moment you can least afford
it to.

## Approach: drain `done` in the same select as `work`

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		select {
		case req := <-work:
			b.dispatch(req)
		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}
```

Both cases run inside the same single goroutine, so there's no need
for a mutex around `b.pool` — `dispatch` (called from the `work` case)
and the `done` case can never execute concurrently with each other.
`heap.Fix` is the right primitive here rather than a `Pop`/`Push` pair:
`w.pending--` changes a value already sitting somewhere inside the
heap (not necessarily at the root), and `Fix` re-establishes heap order
around that one element in `O(log n)` without disturbing anything else
— `w.index` (already maintained by `Pool`'s `Swap`) is exactly the
bookkeeping `Fix` needs to find it.

With this fix, a `Worker`'s full lifecycle closes the loop: `dispatch`
increments `pending` and hands it a request; the `Worker` runs it and
reports back on `done`; `Balance` receives that report, decrements
`pending`, and fixes the heap — so the very next `dispatch` call sees
this `Worker`'s true, current load, no matter how many rounds of
requests have already gone through it.

## A subtlety already handled for you: why `w.requests` is buffered

`dispatch` sends synchronously, inside `Balance`'s own goroutine:

```go
func (b *Balancer) dispatch(req Request) {
	w := heap.Pop(&b.pool).(*Worker)
	w.requests <- req
	w.pending++
	heap.Push(&b.pool, w)
}
```

If `w.requests` were unbuffered, this send would block until Worker
`w` is actively receiving. That sounds harmless — a busy `Worker` will
eventually loop back to receive — except a `Worker` doesn't loop back
to receive *immediately* after finishing its current job; it first has
to get through `done <- w`. If `Balance` is the goroutine stuck
sending it a new request, `Balance` is not available to receive that
`done` report — and the `Worker` can't reach its receive statement
until that report goes through. That's a genuine circular wait between
one `Worker` and the single `Balancer` goroutine, independent of
whether `done` is otherwise handled correctly.

The given code sidesteps this by giving each `Worker` a buffered inbox
(`requestBacklogPerWorker`), so `dispatch`'s send can succeed by
queuing, without needing that specific `Worker` to be mid-receive right
now. This is the same reason Rob Pike's original version of this
program — the one this exercise is modeled on — buffers its worker
channels too. It's a separate concern from the `done`-handling bug
above (the naive code has this buffer already, and the naive code
still wedges), included here because it's the kind of thing that looks
like unrelated plumbing until you try removing it and watch a
*correct* `Balance` deadlock anyway.

## Key takeaways

- A self-scheduling pool needs the reverse channel (`done`, here) to
  be processed by the *same* dispatching loop that reads the pool's
  state — a heap (or any shared ordering) that only ever gets updated
  in one direction silently goes stale the moment reality diverges from
  it, and nothing about the type system catches that for you.
- `heap.Fix` — not a `Pop`/`Push` round trip — is the right tool for
  "this element's key changed, but I still have a handle on it and know
  its index." `container/heap`'s own `index`-tracking convention (seen
  in `Pool.Swap`) exists specifically to make `Fix` and `Remove`
  possible.
- A synchronous send from inside a single dispatching goroutine to one
  of several worker goroutines can deadlock even when the "obvious" bug
  is fixed, if the target worker has its own outstanding synchronous
  send back to that same dispatching goroutine. Buffering one side of
  that exchange is what breaks the cycle — the same shape of problem
  shows up any time two goroutines synchronously send to each other in
  a fixed order.
