# Settle Once: CompareAndSwap Between a Timeout and a Completion

A request can settle two different ways: its own work finishes, or its
deadline fires first. `Responder` is supposed to make sure whichever
happens first is the *only* one that ever reports an outcome —
`Complete` and `Timeout` each call `notify` with what happened, but
`notify` must fire **exactly once** per request, no matter how close
the race is. Right now both guard `notify` with a plain `bool` and no
synchronization at all:

```go
func (r *Responder) Complete(result string) bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("completed: " + result)
	return true
}
```

```
goroutine A (work finishes):  reads settled (false) ──▶ notify("completed") ──▶ settled = true
goroutine B (deadline fires): reads settled (false) ──▶ notify("timed out")  ──▶ settled = true
                                 ↑ both read settled before either wrote it - notify fires TWICE
```

Read-then-write are two separate steps. If `Complete` and `Timeout`
both read `settled` as `false` before either writes it, both think
they won, both call `notify` — the request gets reported as both
succeeded *and* timed out. In a real server this is exactly how
`http: superfluous response.WriteHeader call` happens: a handler
goroutine writes the success response at the very moment a timeout
middleware writes an error response to the same connection.

## Why this one is a genuine CAS problem

A tempting shortcut for a "claim one thing" race is a plain counter:
`atomic.AddInt64(&n, -1)`, undone with `+1` if it went negative. That
trick works when the update has a trivial inverse — decrementing by
one does. **A settle-once transition has no inverse at all.** Once
`notify` has run, there is no operation that un-runs it — the state
only ever moves one way, `pending → settled`. That's the shape
`CompareAndSwap` exists for: *install this value, but only if nothing
already changed it* — not "adjust by a fixed delta and hope you can
undo it."

It's also not something a channel `select` can solve, the way
[31](../31-serve-timeout-race) and [32](../32-fanout-deadline-race)
solve this exact timeout-vs-completion shape. Those exercises have a
single arbitrating *reader* choosing between a result channel and
`ctx.Done()`. Here there is no reader to arbitrate — `Complete` and
`Timeout` are two independent *writers*, each about to perform a side
effect (`notify`) directly, with nothing in between them to pick a
winner. Only a shared, atomically-guarded flag can do that.

### Why not `sync.Once`?

`once.Do(f)` really does guarantee `f` runs at most once — that part
would work here too. The problem is what happens to the *loser*:
`Once`'s fast path is an atomic load, but the first time through, a
losing call falls to `doSlow`, which blocks on `Once`'s internal mutex
until the *winning* call's `f` has fully returned. A timeout path's
entire job is to bail out fast — it must not queue up behind however
long the winner's own `notify` call happens to take. `CompareAndSwap`
gives the loser an instant, non-blocking answer instead of making it
wait its turn.

## Your task

Fix `Responder` so that:

- Exactly one of `Complete` or `Timeout` ever calls `notify`, for any
  single `Responder` — whichever reaches the settle point first.
- The loser returns `false` immediately — without calling `notify`,
  and without waiting for the winner to finish whatever it's doing.

**No `sync.Mutex`, `sync.RWMutex`, or any other lock.** Use
`sync/atomic`'s `CompareAndSwap` idiom instead — here it's a single
check-and-flip, not even a retry loop, since the state only ever moves
one way:

```
won := CAS(&settled, 0, 1)   // install 1, but ONLY if it was still 0
if won:  notify, return true
else:    someone else already settled it - return false, don't wait
```

Signatures stay the same:

```go
func NewResponder(notify func(outcome string)) *Responder
func (r *Responder) Complete(result string) bool
func (r *Responder) Timeout() bool
```

## A note on the demo

Running `main()` will usually print a clean `0/30 requests settled
more than once` — even against the broken version above. That's not a
sign it's already fine: with only *one* `Complete` and *one* `Timeout`
racing per request, the unsynchronized window is a handful of
nanoseconds, easy for two goroutines to simply miss even with zero
synchronization. That's normal for this class of bug, and it's exactly
why the test suite doesn't rely on eyeballing a demo run:

- Plain `go test` pits **hundreds of simultaneous contenders** against
  one `Responder` per round, specifically to widen a two-contender race
  into one that fails reliably within the first few dozen rounds.
- `go test --race` doesn't need the bug to visibly misfire at all — it
  flags the raw unsynchronized read/write on `settled` outright, on
  the very first `Complete`/`Timeout` pair, every time.

## Test your solution

```
go test
go test --race
```
