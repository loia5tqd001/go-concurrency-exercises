# Load-Shedding Balancer: Reject Fast Instead of Queuing Forever — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The bug

`Submit` is a plain blocking send:

```go
func (b *Balancer) Submit(req Request) error {
	b.incoming <- req
	return nil
}
```

`incoming` is a real bounded channel now (capacity `maxBacklog`),
closing [33b](../33b-load-balancer-nonblocking-dispatch)'s own loose
end — no more unbounded memory growth under sustained overload. But
once `incoming`, `run`'s one-item staging slot, and every `Worker` are
all occupied, this send has nowhere to go:

```
incoming: FULL, staging slot: occupied, every Worker: busy
next Submit(req) ──▶ b.incoming <- req ──▶ blocks (not a deadlock -
                       run is still draining - but indistinguishable
                       from one to the caller: no result, no error,
                       no way to know whether to keep waiting)
```

**Verified**:

```
--- FAIL: TestSubmitFailsFastWhenSaturated
    Submit attempt 4 blocked for over 200ms instead of failing fast -
    looks like it's still a blocking send instead of select/default
```

## The fix

```go
func (b *Balancer) Submit(req Request) error {
	select {
	case b.incoming <- req:
		return nil
	default:
		return ErrOverloaded
	}
}
```

`select`+`default` tries the send once, immediately; if `incoming` has
no room *right now*, `default` fires instead of waiting. Different
non-blocking flavor than 33b's `nil`-channel trick: there, a case was
disabled outright so it could never fire that iteration; here every
case is live, and `default` is exactly "if nothing else was ready this
instant, do this instead" — the standard idiom for "try, don't wait."

## The staging slot means the real ceiling is a little higher than `maxBacklog`

```
accepted-but-not-yet-complete ceiling =
   maxBacklog        (incoming's own buffer)
 + 1                 (run's staging slot, held outside incoming)
 + numWorkers         (one in flight per Worker - unbuffered inboxes)
```

`run` (given, unchanged) drains `incoming` into a local `held` variable
one item at a time, waiting there until some `Worker` is free — it
can't block sending to a specific `Worker` without risking 33b's
freeze. That staging slot holds one request *outside* `incoming`'s
buffer, so the true ceiling is `maxBacklog + 1 + numWorkers`, not
exactly `maxBacklog`. `TestSubmitFailsFastWhenSaturated` is written
around that — it asserts `ErrOverloaded` shows up within a generous
margin and that no individual `Submit` ever blocks past a short
deadline, rather than pinning an exact accept count that would be
fragile to this same off-by-a-staging-slot detail.

## Why this isn't in tension with 33b — it resolves 33b's tension

33b explicitly left an open question: an unbounded internal backlog
trades "never deadlocks" for "never says no," which is exactly what
[18](../18-bounded-pipeline-backpressure) warns against. This exercise
resolves it: `incoming` gives the queue a real, finite capacity, and
`Submit` gives the system a way to say no once that capacity's spent —
a **third** option, distinct from both 18's "block the producer until
there's room" and 33b's "queue forever." Blocking is right when the
producer is *supposed* to feel the slowdown and has nowhere better to
go. Failing fast is right when the caller has somewhere better to go —
retry elsewhere, shed the request, degrade gracefully — and would
rather know immediately than wait unboundedly.

## Key takeaways

- `select`+`default` and `select`+`nil`-channel solve different
  problems: `default` answers "is anyone ready for this send/receive
  *right now*?"; a `nil` channel answers "should this case even be a
  candidate this iteration?"
- A bounded queue plus explicit rejection is a third point in the
  backpressure design space, not a strict improvement over blocking —
  it trades "the caller might wait" for "the caller might have to
  handle failure," which only wins when the caller has something
  useful to do with that failure.
- When a design stages an item outside its own advertised buffer (here,
  `run`'s `held` slot), say so precisely — a test that pins the wrong
  ceiling flakes for reasons unrelated to the bug it's meant to catch.

**Verified**: the naive scaffold passes the baseline/concurrency-safety
tests but fails `TestSubmitFailsFastWhenSaturated`, blocking past its
200ms per-call deadline exactly as predicted. The fix above is
`gofmt`/`vet` clean and passes `go test -race -count=5` with no flakes.
