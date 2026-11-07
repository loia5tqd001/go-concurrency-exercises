# Non-Blocking Dispatch: A Load Balancer Without Buffer Dependency — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The bug

`Balance` starts with 33's fix. It already drains `b.done` and calls
`heap.Fix`. But `NewBalancer` now gives every `Worker` an
**unbuffered** inbox.

```go
w := &Worker{requests: make(chan Request)}
```

`Balance`'s dispatch send is still blocking.

```go {3}
case req := <-work:
	w := heap.Pop(&b.pool).(*Worker)
	w.requests <- req   // <-- can block, right here
	w.pending++
	heap.Push(&b.pool, w)
```

This send runs in `Balance`'s single goroutine. It must finish before
the loop can reach `select` again. The chosen `Worker` may be busy. It
may also be blocked on `done <- w` from its previous job. Then
`w.requests <- req` blocks. `Balance` cannot reach its `done` case for
any `Worker`. Every other completion and request waits behind that
send.

```
--- FAIL: TestBalancerSurvivesBackToBackRequestsOnOneWorker (2.00s)
    check_test.go:114: request 1 was never dispatched - balancer looks wedged
    check_test.go:122: request 3 never completed
```

With 33's buffer, the bug needed a burst larger than the pool. With
capacity `0`, it can happen on the next request to a busy `Worker`.

## The fix

Give `Balance` an internal backlog with no fixed size. Turn the dispatch
send into a `select` case. A `nil` channel enables or disables that
case. It is no longer a blocking statement outside `select`:

```go {5,10,17}
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

Every request goes into `backlog` first. The loop does not dispatch a
request in the same iteration it arrives. On each iteration, check
`backlog`. If it is not empty, read `b.pool[0]` to get the
least-loaded `Worker`. The heap guarantees that this `Worker` is at
index `0`. This is a read, not a `Pop`. Then set up a
`dispatch <- head` case for that `Worker`. If `backlog` is empty,
`dispatch` stays `nil`. A send on a `nil` channel never runs. This is
the common way to turn a `select` case on and off. The case drops out
without blocking.

This design does not block. The send to one `Worker` is now inside the
same `select` as `work` and `done`. `Balance` is not forced to finish
that send before it checks other cases. If the target `Worker` is not
ready to receive, `dispatch <- head` is not ready. `Balance` can handle
`done` or a new `req` instead. It then checks the same `head` again.
Nothing is lost. `head` stays at the front of `backlog` until a
`Worker` receives it.

## Why peeking is the right check

It is tempting to gate dispatch on `w.pending`. Do not do that.
`pending` is only what `Balance` believes a `Worker` carries. Its value
can lag reality in either direction. A `Worker` may have taken its
item but not started it. Another may be about to send `done` but has
not reduced `pending` yet. A `pending` threshold can miss a wakeup.
Nothing forces a new check when the real receive state changes.

The design above checks only two facts. Which `Worker` is least loaded?
Can it receive *right now*? Go's `select` runtime answers the second
question. The send is attempted on every iteration. It succeeds only
when a real receiver is waiting. That is the only truthful answer to
"is anybody listening."

## `heap.Fix`, not `heap.Pop` + `heap.Push`, on dispatch

The `dispatch <- head` case increases `pending`, then calls
`heap.Fix(&b.pool, w.index)`. It matches the `pending--` and `heap.Fix`
pair in the `done` case. The code only peeked at `w` with `b.pool[0]`.
It did not pop it. So its `index` is still valid and starts at `0`.
`Fix` repairs the heap around that element in `O(log n)`. It avoids a
`Pop` and `Push` round trip. This is the same reason `33` asks you to
use `heap.Fix`.

## The near-miss that also passes the functional tests

You may try to fix the blocking send by running it in its own
goroutine. Keep `heap.Pop`, `w.requests <- req`, and `heap.Push`
unchanged:

```go {3}
case req := <-work:
	w := heap.Pop(&b.pool).(*Worker)
	go func() { w.requests <- req }()   // <-- looks non-blocking...
	w.pending++
	heap.Push(&b.pool, w)
```

This does not block `Balance`'s loop. Every request in the test suite
still completes. So it is not a functional bug. But it creates one live
goroutine per waiting request. Each goroutine waits while its `Worker`
stays busy. The plain `backlog` slice avoids those goroutines. A
round-robin dispatcher that also spawns a goroutine per send has the
same problem. `TestBalancerQueuesWithoutASeparateGoroutinePerRequest`
catches both designs. It sends a burst larger than the pool can run at
once. It sends from the test's own goroutine, so no submitter
goroutines confuse the count. It checks that `runtime.NumGoroutine()`
barely moves. A correct `Balance` keeps the backlog in a slice. It does
not keep it in parked goroutines.

## An explicit tension with exercise 18

[18](../18-bounded-pipeline-backpressure) argues against unbounded
buffering. A fast producer should feel a slow consumer's backpressure.
It should not queue forever. This exercise's `backlog` is an unbounded
slice with no cap. That is a deliberate exception, not a contradiction.
`Balance` is one goroutine. It also owns the only path that unblocks
every `Worker` through `done`. If dispatch blocks, `done` cannot be
serviced. The whole pool freezes. That is worse than a slice that
grows under sustained overload. A production version should bound
`backlog`. It should reject or shed load past that limit. But the
dispatch loop must never stop reading `done`.

## Key takeaways

- One goroutine may send to and receive from other parties. It cannot
  block on the send. Receiving is what breaks the deadlock. A blocked
  send gives up that ability.
- The `nil`-channel `select` idiom leaves a channel variable unset. Its
  `case` then stays disabled. This lets a conditional send or receive
  share one `select` with other cases.
- `heap.Fix` works the same way when load rises or falls. Only the
  `pending` change before and after differs.

**Verified**: the naive scaffold passes only two of six tests:
`TestWorkerInboxIsUnbuffered` and
`TestBalancerCompletesABurstNoBiggerThanThePool`. Fresh `Worker`s are
always ready. The other four fail.
`TestBalancerSurvivesBackToBackRequestsOnOneWorker`,
`TestBalancerSurvivesMoreRequestsThanWorkers`, and
`TestBalancerQueuesWithoutASeparateGoroutinePerRequest` each show the
same `... balancer looks wedged` message as 33's bug.
`TestBalancerConcurrentSafety` times out under load. The fix above is
`gofmt` and `vet` clean. It passes `go test -race -count=20` without
flakes. It also handled an ad hoc 200-request burst against 2 workers.
