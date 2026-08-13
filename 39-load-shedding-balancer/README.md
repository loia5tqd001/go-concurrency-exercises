# Load-Shedding Balancer: Reject Fast Instead of Queuing Forever

A production-shaped sequel to [33](../33-load-balancer)/[33b](../33b-load-balancer-nonblocking-dispatch)'s
self-scheduling load balancer. `Submit` is the only entry point now —
there's no exported `work` channel for a caller to pick their own
buffering strategy on. Everything after `Submit` is already correct
and doesn't need touching: the `Worker`/`Pool` self-scheduling, the
unbuffered inboxes, and the internal dispatch loop that never blocks
on a busy `Worker` — 33b's fix, ported wholesale.

What's new: `incoming` is a real bounded channel (capacity
`maxBacklog`), not an unbounded slice. That closes 33b's own loose end
— sustained overload now hits a hard ceiling instead of growing
memory forever — but a bounded queue raises a question 33b never had
to answer: **what happens once it's full?**

## The bug

Right now, nothing special:

```go
func (b *Balancer) Submit(req Request) error {
	b.incoming <- req
	return nil
}
```

Once `incoming`, the dispatch loop's own one-item staging slot, and
every `Worker` are all occupied, the *next* `Submit` call just sits
there — waiting for something, somewhere, to finish. That's not a
deadlock; the system is still making progress and will eventually
drain. But it's exactly the failure mode a real load balancer can't
afford: a caller that expected a fast yes-or-no now hangs for as long
as the balancer stays saturated, with no way to know whether to retry,
fail over to something else, or give up — the same problem 18's
[bounded pipeline](../18-bounded-pipeline-backpressure) accepts on
purpose (its producer is *meant* to feel the slowdown), but here the
caller has no way to distinguish "briefly busy" from "wedged."

## Your task

Make `Submit` fail fast: the instant `incoming` has no room, it must
return `ErrOverloaded` immediately — never block waiting for space to
free up.

Exported surface stays the same:

```go
func NewBalancer(numWorkers, maxBacklog int) *Balancer
func (b *Balancer) Submit(req Request) error
```

You should not need to change `Request`, `Worker`, `Pool`, or `run`.

## Hint, if you're stuck

The idiom is `select` with a `default` case: try the send; if nobody's
ready for it *right now*, take the other branch instead of waiting.
That's a different flavor of non-blocking `select` than 33b's
`nil`-channel trick — there, a case was conditionally disabled
entirely so it could never fire; here, every case is real, and
`default` is what runs when none of them can proceed at this instant.

## Test your solution

```
go test
go test --race
```
