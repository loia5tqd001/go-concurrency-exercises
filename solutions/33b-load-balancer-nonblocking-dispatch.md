# Non-Blocking Dispatch: A Load Balancer That Can't Depend on a Buffer — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The bug

`Balance` starts from 33's own fix — it already drains `b.done` and
calls `heap.Fix` — but `NewBalancer` now hands every `Worker` an
**unbuffered** inbox:

```go
w := &Worker{requests: make(chan Request)}
```

`Balance`'s dispatch send is still

```go
case req := <-work:
	w := heap.Pop(&b.pool).(*Worker)
	w.requests <- req   // <-- can block, right here
	w.pending++
	heap.Push(&b.pool, w)
```

and that send runs inside `Balance`'s own single goroutine, before it
can loop back to `select`. The moment the chosen `Worker` isn't
already parked on a receive — it's mid-job, or itself blocked on
`done <- w` trying to report its *previous* job's completion —
`w.requests <- req` blocks. With that, `Balance` can't reach its own
`done` case either, for *any* `Worker`. Every other `Worker`'s
completion, and every later request, backs up behind that one send
forever.

```
--- FAIL: TestBalancerSurvivesBackToBackRequestsOnOneWorker (2.00s)
    check_test.go:114: request 1 was never dispatched - balancer looks wedged
    check_test.go:122: request 3 never completed
```

Against 33's buffered inbox, this took a burst bigger than the whole
pool to surface. Here, with capacity `0`, it can happen on the very
next request that lands on a `Worker` that isn't fresh.

## The fix

Give `Balance` its own internal, unbounded backlog, and make the
dispatch send itself a `select` case — conditionally enabled via a
`nil` channel — instead of a blocking statement that runs outside the
`select`:

```go
func (b *Balancer) Balance(work <-chan Request) {
	var backlog []Request

	for {
		var dispatch chan<- Request
		var head Request
		var w *Worker
		if len(backlog) > 0 {
			w = b.pool[0] // peek the least-loaded Worker; don't Pop yet
			dispatch, head = w.requests, backlog[0]
		}

		select {
		case req := <-work:
			backlog = append(backlog, req)

		case dispatch <- head:
			backlog = backlog[1:]
			w.pending++
			heap.Fix(&b.pool, w.index)

		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}
```

Every incoming request goes straight into `backlog` — nothing is ever
dispatched in the same iteration it arrives. On every loop iteration,
if `backlog` is non-empty, peek `b.pool[0]` (the heap invariant
guarantees the least-loaded `Worker` sits at index `0`, so this is a
plain read, not a `Pop`) and wire up a `dispatch <- head` case aimed at
its inbox. If `backlog` is empty, `dispatch` stays a `nil` channel, and
a `case` that sends on a `nil` channel is simply never ready — the
classic idiom for turning a `select` case on and off — so that branch
quietly drops out.

This is why it doesn't block: the send to a specific `Worker` now
lives *inside* the same `select` as `work` and `done`, not as a
statement `Balance` is committed to before it can look at anything
else. If the target `Worker` isn't parked on a receive yet, `dispatch
<- head` just isn't ready this iteration — `Balance` falls through to
whichever other case *is* ready (typically `done`, freeing up some
other `Worker`, or a new `req` arriving), and revisits the same peek
next time around. Nothing is lost by not sending immediately: `head`
stays at the front of `backlog` until a `Worker` actually receives it.

## Why peeking, not a stale-load check, is what makes this correct

It's tempting to gate dispatch on `w.pending` instead — "only try to
send if the least-loaded `Worker`'s `pending` is low enough." Don't:
`pending` counts what `Balance` believes a `Worker` is carrying, and
that can lag reality by one step in either direction (a `Worker` that
already dequeued its item but hasn't yet run it still reads as
"pending"; one that's about to send `done` hasn't decremented yet
either). Predicating the `select` on a `pending` threshold reintroduces
a missed-wakeup risk: nothing forces a re-check when the real
receiving state changes.

The design above sidesteps that entirely by not checking any state at
all beyond "which `Worker` is currently least-loaded, and can it
receive *right now*" — literally letting Go's `select` runtime answer
that question by attempting the send unconditionally every iteration.
The send only succeeds when a real receiver is actually parked on the
other end, at the exact instant `select` evaluates its cases, which is
the only truthful answer to "is anybody listening."

## The `heap.Fix`, not `heap.Pop`+`heap.Push`, on the dispatch path

The `dispatch <- head` case calls `heap.Fix(&b.pool, w.index)` after
incrementing `pending`, mirroring the `done` case's
`pending--`/`heap.Fix` pair. Since `w` was only *peeked* (`b.pool[0]`),
not popped, its `index` is still valid and still `0` going in — `Fix`
restores heap order around that one element in `O(log n)` without a
round trip through `Pop`+`Push`, exactly the primitive 33 asks you to
use for the same reason.

## The near-miss that also passes the functional tests

It's tempting to "fix" the blocking send a different way: keep
`heap.Pop`/`w.requests <- req`/`heap.Push` exactly as it was, just run
the send in its own goroutine —

```go
case req := <-work:
	w := heap.Pop(&b.pool).(*Worker)
	go func() { w.requests <- req }()   // <-- looks non-blocking...
	w.pending++
	heap.Push(&b.pool, w)
```

This never blocks `Balance`'s own loop, so every request in the test
suite above still eventually completes — it's not a functional bug.
What it costs is one live goroutine per request still waiting on a busy
`Worker`, for as long as that `Worker` stays backed up, instead of the
plain `backlog` slice `Balance` already owns. A round-robin dispatcher
that also ignores the heap and spawns a goroutine per send falls into
the identical trap for the identical reason. `TestBalancerQueuesWithoutASeparateGoroutinePerRequest`
catches both: it submits a burst well beyond what the pool can be
running at once, from the test's own goroutine (no submitter
goroutines to muddy the count), and asserts `runtime.NumGoroutine()`
barely moves — a correct `Balance` is holding the backlog in a slice,
not in parked goroutines.

## An explicit tension with exercise 18

[18](../18-bounded-pipeline-backpressure) argues *against* unbounded
buffering — a fast producer should be made to feel a slow consumer's
backpressure, not queue against it forever. This exercise's `backlog`
slice is exactly that: unbounded, growable, with no cap. That's a
deliberate, narrow exception, not a contradiction: `Balance` is a
single goroutine that also owns the *only* path back to unblocking
every `Worker` via `done`. If dispatch itself is allowed to block, it
can't service `done`, and the whole pool freezes — a far worse failure
than a slice that grows a little under sustained overload. A
production version would still want to bound `backlog` and reject or
shed load past some limit; the one thing it can never do is let the
dispatch loop itself become the reason `done` never gets read.

## Key takeaways

- A single goroutine that both sends to and receives from other
  parties can't afford to block on the send — the *ability to receive*
  is what breaks the deadlock, and a blocked send forfeits it.
- The `nil`-channel `select` idiom — leave a variable-typed channel
  unassigned (`nil`) to disable its `case` — is how you make a
  conditional send or receive coexist with other cases in one
  `select`, instead of running it as a separate blocking statement.
- `heap.Fix` works the same way whether load went up or down; only the
  before/after `pending` mutation differs.

**Verified**: of the six tests, only two pass against the naive scaffold
above — `TestWorkerInboxIsUnbuffered` and
`TestBalancerCompletesABurstNoBiggerThanThePool` (fresh `Worker`s are
always ready). The remaining four fail: `TestBalancerSurvivesBackToBackRequestsOnOneWorker`,
`TestBalancerSurvivesMoreRequestsThanWorkers`, and
`TestBalancerQueuesWithoutASeparateGoroutinePerRequest` each hit the
same `... balancer looks wedged` signature reported for 33's own bug,
and `TestBalancerConcurrentSafety` times out under load. The fix above
is `gofmt`/`vet` clean and passes `go test -race -count=20` with no
flakes, and holds up under an ad hoc 200-request burst against just 2
workers.
