# Non-Blocking Dispatch: A Load Balancer That Can't Depend on a Buffer

This exercise follows [33](../33-load-balancer).

`Balancer` already has everything exercise 33 asked for. `Balance`
drains both `work` and `b.done` in one `select`. It keeps the pool
ordered with `heap.Fix`, just like the fix in 33:

```go {6}
func (b *Balancer) Balance(work <-chan Request) {
	for {
		select {
		case req := <-work:
			w := heap.Pop(&b.pool).(*Worker)
			w.requests <- req
			w.pending++
			heap.Push(&b.pool, w)

		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}
```

Every `Worker` inbox (`w.requests`) is **unbuffered**. `NewBalancer`
creates it with `make(chan Request)`, capacity `0`. This is a fixed
rule. A test checks it directly. You cannot turn the buffer back on.

## The bug

That one change can wedge `Balance`, even with correct `done` handling.
Follow the steps:

1. `Balance` picks the least loaded `Worker`. It sends with
   `w.requests <- req`. That send runs inside its only goroutine. It
   happens before the next `select`.
2. The `Worker` may not be waiting on a receive. It may be running a
   job. It may be blocked sending its completion on `b.done`. Then the
   send blocks.
3. `Balance` is now stuck on that send. It cannot reach its own `done`
   case for any `Worker`.
4. Every other `Worker` that finishes a job piles up behind the same
   block. Every later request piles up behind `work`.

```
Balance picks Worker w (heap.Pop), blocks on w.requests <- req
                                         │
        w is off running its current job, not parked on a
        receive yet
                                         │
   w finishes, tries done <- w to report back - nobody's
   listening, because Balance is still stuck on the send above
                                         │
     every OTHER Worker's completions, and every later request,
     now queue up behind that one stuck send - forever
```

With 33's buffer, it took a larger burst to fill the per-worker buffers.
Here, the next request can block on a `Worker` that is not receiving.
There is no buffer between "not receiving yet" and "send blocks."

## Your task

> **Static constraint:** `Worker.requests` must stay unbuffered. Its
> capacity must stay `0`. A test asserts this. Fix `Balance` without a
> buffer. Do not quietly restore one.

Rewrite `Balance`. It must never block while sending to one `Worker`.
This must hold even when that worker is backed up. A request that
cannot be handed off at once must wait inside `Balance`. The data
structure belongs to its loop. Do not park one goroutine per waiting
request.

Every request must still finish. The least loaded `Worker` must get
first claim on queued work once it has room. Keep the exported surface
the same:

```go
func NewBalancer(numWorkers int) *Balancer
func (b *Balancer) Balance(work <-chan Request)
```

You should not need to change `Request`, `Worker`, or `Pool`.

## Hint, if you're stuck

The standard Go idiom uses a `nil` channel to turn a `select` case on or
off. A `nil` channel is never ready, so its `case` never fires. Use
this for the dispatch case. Enable it when a request is queued and its
target `Worker` can take it now. Keep it in the same `select` as `work`
and `done`. Do not send outside the `select`. That is what let one
`Worker` block the loop.

## Test your solution

```
go test
go test --race
```
