# Load-Shedding Balancer: Reject Fast Instead of Queuing Forever

A production-shaped sequel to
[33](../33-load-balancer)/[33b](../33b-load-balancer-nonblocking-dispatch)'s
self-scheduling load balancer. `Submit` is the only entry point now.
Everything after it is already correct and doesn't need touching: the
`Worker`/`Pool` self-scheduling and the internal dispatch loop that
never blocks on a busy `Worker` — 33b's fix, ported wholesale.

What's new: `incoming` is a real bounded channel (capacity
`maxBacklog`), not an unbounded slice — closing 33b's own loose end,
sustained overload now hits a hard ceiling instead of growing memory
forever. But a bounded queue raises a question 33b never had to
answer: **what happens once it's full?**

## The bug

```go
func (b *Balancer) Submit(req Request) error {
	b.incoming <- req
	return nil
}
```

```
incoming (cap maxBacklog): [███████████] FULL
dispatch loop's staging slot: occupied
every Worker: busy

next Submit(req) ──▶ b.incoming <- req ──▶ blocks... waiting for ANYTHING to free up
                                             (not a deadlock - system is draining -
                                              but the caller has no idea how long)
```

Once `incoming`, the dispatch loop's one-item staging slot, and every
`Worker` are all occupied, the next `Submit` call just sits there. Not
a deadlock — the system is still draining — but exactly the failure
mode a real load balancer can't afford: a caller expecting a fast
yes/no hangs for as long as the balancer stays saturated, with no way
to know whether to retry, fail over, or give up. Contrast [18](../18-bounded-pipeline-backpressure),
where the producer is *meant* to feel the slowdown — here the caller
needs to tell "briefly busy" from "wedged," and blocking can't do that.

## Your task

Make `Submit` fail fast: the instant `incoming` has no room, return
`ErrOverloaded` immediately — never block waiting for space.

Exported surface stays the same:

```go
func NewBalancer(numWorkers, maxBacklog int) *Balancer
func (b *Balancer) Submit(req Request) error
```

You should not need to change `Request`, `Worker`, `Pool`, or `run`.

## Hint, if you're stuck

```go
select {
case ch <- v:
	// sent
default:
	// nobody was ready RIGHT NOW - do this instead
}
```

`select` + `default` tries the send once; if nothing's ready this
instant, `default` runs instead of waiting. Different flavor of
non-blocking `select` than 33b's `nil`-channel trick — there, a case
was disabled entirely so it could never fire; here every case is real,
and `default` is what runs when none of them can proceed right now.

## Test your solution

```
go test
go test --race
```
