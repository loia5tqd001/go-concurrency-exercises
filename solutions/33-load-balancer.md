# Load Balancer: Self-Scheduling Workers That Report Their Own Load — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The bug

`Balance` only reads `work`, never `b.done`:

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}
```

That's invisible for a first burst of ≤ `numWorkers` requests — everyone
gets a fresh `Worker`. It wedges the instant a request has to reach a
`Worker` that already finished its first job:

```
Worker finishes 1st request ──▶ done <- w blocks forever (nobody's listening)
                                          │
Balance dispatches a 2nd request to that same Worker:
    w.requests <- req ──▶ blocks forever (Worker never comes back to receive)
                                          │
        Balance's ONE goroutine is now stuck on that send
                                          │
      every later request queued behind it in `work` waits forever too
```

```
--- FAIL: TestBalancerSurvivesMoreRequestsThanWorkers (2.00s)
    check_test.go:109: request 6 never completed
```

Looks completely correct under light load (one request per backend, no
queuing) and only wedges once traffic exceeds pool size — the one
moment you can least afford it.

## The fix

Drain `done` in the same `select` as `work`:

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

Both cases run in the same goroutine, so `b.pool` needs no mutex —
`dispatch` and the `done` case can never race each other. `heap.Fix`
(not `Pop`/`Push`) is the right primitive: `w.pending--` changes a
value already sitting somewhere inside the heap, and `Fix` restores
heap order around just that element in `O(log n)`, using the `index`
`Pool.Swap` already maintains.

```
 dispatch: pending++, heap.Push          done: pending--, heap.Fix
      ┌───────────────────────┐    ┌───────────────────────┐
      ▼                       │    ▼                       │
work ─▶ Balance ───────────────────▶ Balance ◀──────────────┘
                                     ▲
                                     └── done ◀── Worker.work
```

With this, a `Worker`'s full lifecycle closes: `dispatch` increments
`pending` and hands it a request; the `Worker` runs it and reports
back; `Balance` decrements `pending` and fixes the heap — so the next
`dispatch` always sees this `Worker`'s true, current load.

## Already-handled subtlety: why `w.requests` is buffered

`dispatch`'s send is synchronous, from inside `Balance`'s own
goroutine. If `w.requests` were unbuffered, sending to a `Worker` that
just finished a job — but hasn't yet gotten past its own `done <- w`
— would deadlock: `Balance` can't proceed past that send, so it can't
reach the `done` case that would unblock the `Worker`. That's a
circular wait between one `Worker` and the single `Balancer` goroutine,
independent of whether `done` is handled correctly. `requestBacklogPerWorker`
sidesteps it by letting the send queue instead of blocking — the same
reason Pike's original version buffers its worker channels. This is
already in place in the given code and isn't part of the fix above.

## `requestBacklogPerWorker` is load-bearing, not cosmetic

Empirically confirmed while reviewing this exercise: shrinking
`requestBacklogPerWorker` to `0` reproduces the original bug's exact
failure (`request N was never dispatched - balancer looks wedged`),
and even `1` deadlocks a single-`Worker` pool under a burst faster than
that `Worker` can drain. This isn't backpressure that just slows things
down — it's a real circular wait: `Balance`'s dispatch send blocks
*inside* the same goroutine that reads `done`, so a full buffer freezes
`done`-draining for every `Worker` in the pool, not only the backed-up
one. `16` is sized for this exercise's own traffic, nothing more.
[33b](../33b-load-balancer-nonblocking-dispatch) removes the buffer
entirely (capacity `0`) and asks for a dispatcher that's correct
without leaning on one.

## Key takeaways

- A self-scheduling pool's `done` channel must be drained by the *same*
  loop that reads the pool's state — an ordering that only ever updates
  in one direction goes stale the moment reality diverges from it.
- `heap.Fix` is for "this element's key changed, but I still hold its
  index" — cheaper and more direct than a `Pop`/`Push` round trip.
- Two goroutines synchronously sending to each other in a fixed order
  can deadlock even after the "obvious" bug is fixed; buffering one
  side breaks the cycle.

**Verified**: naive `main.go` fails `TestBalancerSurvivesMoreRequestsThanWorkers`
(passes only the no-more-requests-than-workers sanity check). The fix
above is `gofmt`/`vet` clean and passes `go test -race -count=5` with
no flakes.
