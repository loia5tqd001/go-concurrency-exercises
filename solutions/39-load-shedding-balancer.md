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

`incoming` is a real bounded channel now (capacity `maxBacklog`), which
closes [33b](../33b-load-balancer-nonblocking-dispatch)'s own loose
end — no more unbounded memory growth under sustained overload. But
once `incoming`, the `run` loop's one-item staging slot, and every
`Worker` are all occupied, this send has nowhere to go, and `Submit`
just sits there. That's not a deadlock in the classic sense — `run` is
still making progress, draining `incoming` as fast as `Worker`s free
up — but from the caller's point of view it's indistinguishable from
one: no result, no error, no way to know whether to keep waiting,
retry elsewhere, or give up.

```
--- FAIL: TestSubmitFailsFastWhenSaturated
    check_test.go:98: Submit attempt 4 blocked for over 200ms instead
    of failing fast - looks like it's still a blocking send instead of
    select/default
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

`select` with a `default` case tries the send once, immediately; if
`incoming` has no room *right now*, `default` fires instead of
waiting. This is a different non-blocking flavor than 33b's `nil`-
channel trick: there, a case was conditionally disabled outright so it
could never fire that iteration; here every case is live, and
`default` is exactly "if nothing else was ready this instant, do this
instead" — the standard idiom for "try, don't wait."

## The staging slot means the real ceiling is a little higher than `maxBacklog`

`run` (given, unchanged) drains `incoming` into a local `held` variable
one item at a time, waiting there until some `Worker` is free to
receive it — because, same as 33b, it can't block trying to send to a
specific `Worker` without risking the exact freeze 33b was built to
avoid. That staging slot holds one request *outside* `incoming`'s own
buffer. So the true number of requests the system can have accepted-
but-not-yet-complete at any instant is `maxBacklog` (the channel
buffer) + `1` (the staging slot) + `numWorkers` (one in flight per
`Worker`, since their inboxes are unbuffered) — not exactly
`maxBacklog`. `TestSubmitFailsFastWhenSaturated` is written around
that: it doesn't assert an exact accept count, just that `ErrOverloaded`
shows up within a generous margin, and that *no* individual `Submit`
call is ever allowed to block past a short deadline. Pin the exact
count instead and the test becomes fragile to this same off-by-a-
staging-slot detail rather than testing the thing that actually
matters.

## Why this isn't in tension with 33b — it resolves 33b's tension

33b explicitly left an open question in its own write-up: an unbounded
internal backlog trades "never deadlocks" for "never says no," which
is exactly what [18](../18-bounded-pipeline-backpressure) warns
against. This exercise is the resolution: `incoming` gives the queue a
real, finite capacity, and `Submit` gives the system a way to say no
once that capacity's spent — a **third** option, distinct from both
18's "block the producer until there's room" and 33b's "queue
forever." Blocking (18's choice) is right when the producer is
*supposed* to feel the slowdown and there's nowhere better for it to
go. Failing fast (this exercise's choice) is right when the caller has
somewhere better to go — retry a different backend, shed the request,
degrade gracefully — and would rather know immediately than find out
after an unbounded wait.

## Key takeaways

- `select` with `default` and `select` with a `nil` channel solve
  different problems: `default` answers "is anyone ready for this
  send/receive *right now*, or should I do something else instead?";
  a `nil` channel answers "should this case even be a candidate this
  iteration?" Confusing the two leads to reaching for the wrong one —
  `default` doesn't disable a case, it just gives up on it for one
  attempt.
- A bounded queue plus an explicit rejection is a third point in the
  backpressure design space, not a strict improvement over blocking:
  it trades "the caller might wait" for "the caller might have to
  handle failure," which is only better when the caller actually has
  something useful to do with that failure.
- When a design stages an item outside its own advertised buffer (here,
  `run`'s one-item `held` slot), say so precisely rather than letting
  tests quietly assume a round number — the gap is small but real, and
  a test that pins the wrong ceiling will flake for reasons that have
  nothing to do with the bug it's meant to catch.

**Verified**: the naive scaffold passes the baseline and concurrency-
safety tests but fails `TestSubmitFailsFastWhenSaturated`, blocking past
its 200ms per-call deadline exactly as predicted. The fix above is
`gofmt`/`vet` clean and passes `go test -race -count=5` with no flakes.
