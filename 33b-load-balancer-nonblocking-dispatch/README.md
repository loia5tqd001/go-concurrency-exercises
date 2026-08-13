# Non-Blocking Dispatch: A Load Balancer That Can't Depend on a Buffer

This exercise picks up right where [33](../33-load-balancer) left off.
Given is a `Balancer` whose `Balance` already does everything 33
asked for — it drains both `work` and `b.done` in the same `select`,
and keeps the pool ordered with `heap.Fix`, exactly as 33's own fix
does:

```go
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

What's new: every `Worker`'s inbox (`w.requests`) is **unbuffered** —
`NewBalancer` makes it with `make(chan Request)`, capacity `0`. That's
a fixed constraint of this exercise (a test checks it directly), not a
knob you can turn back up.

## The bug

That one change is enough to wedge the `Balance` above, even though
its `done`-handling is exactly what fixed 33. Trace it:

1. `Balance` picks the least-loaded `Worker` and does
   `w.requests <- req` — synchronously, inside its own single
   goroutine, before it can loop back around to `select` again.
2. If that `Worker` isn't parked on a receive right now — it's mid-job,
   or itself blocked trying to send its *own* completion on `b.done` —
   nobody's listening, so the send blocks.
3. `Balance`'s one goroutine is now stuck on that send. It can no
   longer reach its own `done` case, for *any* `Worker` — not just the
   one it's stuck sending to.
4. Every other `Worker` that finishes a job and tries to report back on
   `done` piles up behind that same block, and every later request
   piles up behind `work`.

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

Against 33's buffered inbox, this needed a burst bigger than the whole
pool before it showed up. Here it can happen on the very next request
after the very first one, because there's no buffer standing between
"not receiving yet" and "send blocks."

## Your task

> **Static constraint:** `Worker.requests` must stay unbuffered
> (capacity `0`) — a test asserts this directly. The fix has to make
> `Balance` correct *without* a buffer to lean on, not quietly restore
> one.

Rewrite `Balance` so it never blocks trying to send to any one
`Worker`, no matter how backed up that `Worker` is — a request that
can't be handed off immediately must queue *inside* `Balance`, not
stall its loop. Every request submitted must still eventually
complete, and the least-loaded `Worker` must still get first claim on
whatever's queued once it has room.

Exported surface stays the same:

```go
func NewBalancer(numWorkers int) *Balancer
func (b *Balancer) Balance(work <-chan Request)
```

You should not need to change `Request`, `Worker`, or `Pool`.

## Hint, if you're stuck

The classic Go idiom for "conditionally enable a `select` case" is a
`nil` channel: a `nil` channel is never ready, so a `case` that
sends or receives on one simply never fires. Use that to make "there's
a request queued *and* its target `Worker` can take it right now" a
third case living in the *same* `select` as `work` and `done` — instead
of a send you make outside the `select`, which is exactly what let one
`Worker` block the whole loop above.

## Test your solution

```
go test
go test --race
```
