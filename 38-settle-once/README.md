# Settle Once: CompareAndSwap Between a Timeout and a Completion

A request can settle in two ways. Its work finishes, or its deadline
fires first. `Responder` must let only the first outcome report.
`Complete` and `Timeout` both call `notify` with their outcome. `notify`
must run **exactly once** per request. This must hold even when the two
paths are close. Today, both paths check a plain `bool` with no
synchronization:

```go {2,5}
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
goroutine B (deadline fires): reads settled (false) ──▶ notify("timed out") ──▶ settled = true
                                 ↑ both read settled before either wrote it - notify fires TWICE
```

`Complete` and `Timeout` both read `settled` as `false`. They read
before either writes it. Both think they won. Both call `notify`. The
request is reported as both completed and timed out.

In a real server, this can cause
`http: superfluous response.WriteHeader call`. A handler writes success
while timeout middleware writes an error to the same connection.

## Why this one is a genuine CAS problem

A plain counter can look tempting for a one-winner race. For example,
code can call `atomic.AddInt64(&n, -1)` and undo it with `+1` if the
value went negative. That works only when the update has a simple
inverse.

A settle-once change has no inverse. Once `notify` runs, no operation
can undo it. The state moves only one way: `pending → settled`. This is
where `CompareAndSwap` fits. It installs a value only if nothing
changed it first. It does not adjust by a delta and hope for an undo.

A result channel and one `select` cannot choose the winner here.
Exercises [31](../31-serve-timeout-race) and
[32](../32-fanout-deadline-race) use a single reader. It chooses
between a result channel and `ctx.Done()`. Here, `Complete` and
`Timeout` are two independent writers. Each is about to call `notify`.
There is no reader between them to choose a winner. They need a shared
atomic claim.

### Why not `sync.Once`?

`once.Do(f)` does guarantee that `f` runs at most once. That part would
work here. The problem is the loser. `Once` first checks an atomic load.
On the first call, a losing call falls into `doSlow`. It waits on an
internal mutex until the winner's `f` returns.

A timeout path must return fast. It cannot wait behind a long `notify`.
`CompareAndSwap` gives the loser an instant, non-blocking answer.

## Your task

Fix `Responder` so that:

- Exactly one of `Complete` or `Timeout` calls `notify`. The first to
  reach the settle point wins.
- The loser returns `false` at once. It does not call `notify`. It does
  not wait for the winner.

**No `sync.Mutex`, `sync.RWMutex`, or `sync.Map`.** Use the
`CompareAndSwap` idiom from `sync/atomic`. This is a single check and
flip. It needs no retry loop because the state moves in one direction.

```
won := CAS(&settled, 0, 1)   // install 1, but ONLY if it was still 0
if won:  notify, return true
else:    someone else already settled it - return false, don't wait
```

Keep the signatures the same:

```go
func NewResponder(notify func(outcome string)) *Responder
func (r *Responder) Complete(result string) bool
func (r *Responder) Timeout() bool
```

## A note on the demo

Running `main()` usually prints a clean
`0/30 requests settled more than once`, even with the broken code. This
does not prove it is fixed. Each request has only one `Complete` and one
`Timeout`. The unsynchronized window is a few nanoseconds. The two
goroutines can miss it, even with no synchronization. This is normal for
this bug. The tests do not rely on a demo run.

- Plain `go test` uses **hundreds of simultaneous contenders** with one
  `Responder` per round. This widens the two-caller race. It should fail
  reliably within a few dozen rounds.
- `go test --race` does not need a visible double call. It finds the
  unsynchronized read and write on `settled` on the first
  `Complete`/`Timeout` pair, every time.

## Test your solution

```
go test
go test --race
```
