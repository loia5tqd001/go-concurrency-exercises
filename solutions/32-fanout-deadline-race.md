# Racing a Fan-Out Against a Deadline — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `32-fanout-deadline-race/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`Construct` builds a `Result` by fanning out to four independent
components — `basic`, `shipping`, `refund`, `history` — concurrently,
each writing into its own field of a shared `Result`, then waiting for
all four before returning it. None of the components take a `ctx`:
each is a stand-in for a synchronous piece of work (a downstream call,
a computation) that has no way to notice a cancellation once started.

The given implementation fans out correctly but waits unconditionally:

```go
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
	var result Result
	var wg sync.WaitGroup

	wg.Add(4)
	go func() { defer wg.Done(); result.Basic = basic() }()
	go func() { defer wg.Done(); result.Shipping = shipping() }()
	go func() { defer wg.Done(); result.Refund = refund() }()
	go func() { defer wg.Done(); result.History = history() }()

	wg.Wait()
	return &result, nil
}
```

The task is to fix `Construct` so it returns promptly with `ctx.Err()`
(and a `nil` `*Result`) once `ctx`'s deadline passes, instead of always
waiting for the slowest component — while never reading `result` on
the path where it bails out early, since the other components'
goroutines may still be writing to it. The signature —
`func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error)` —
must stay the same.

## Why the naive version is wrong

`wg.Wait()` blocks until every component's goroutine has returned,
full stop — `ctx` is accepted as a parameter but never consulted. If
one component (`history`, in the test) takes 500ms and the caller only
budgeted 100ms, `Construct` still takes the full 500ms:

```
--- FAIL: TestConstructRespectsDeadlineWhenAComponentStalls (0.00s)
    check_test.go:76: Construct returned no error; want an error from the 100ms deadline expiring (took 500ms)
```

`TestConstructReturnsAllFieldsWithAmpleDeadline` still passes against
the naive version — with a 2s deadline and 20ms components, nothing
ever times out, so the bug doesn't show up on the happy path. This is
exactly the risk a real fan-out-to-many-components function runs in
production: it looks correct in every normal test, and only blocks
past its caller's deadline once one branch is unusually slow — at
which point the caller has already moved on (its own RPC-level timeout
already fired and returned an error upstream), but this function is
still silently burning time no one is waiting for anymore.

## Approach 1: Race `wg.Wait()` against `ctx.Done()`, and don't touch `result` on the losing branch

```go
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
	var result Result
	var wg sync.WaitGroup

	wg.Add(4)
	go func() { defer wg.Done(); result.Basic = basic() }()
	go func() { defer wg.Done(); result.Shipping = shipping() }()
	go func() { defer wg.Done(); result.Refund = refund() }()
	go func() { defer wg.Done(); result.History = history() }()

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return &result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
```

Walking through the pieces:

- **`wg.Wait()` itself takes no `ctx` and can't be raced against
  directly** — it's not a channel operation, so it can't appear in a
  `select`. The fix is the standard workaround: a dedicated goroutine
  calls `wg.Wait()` and then closes a plain `done` channel, which *can*
  be selected on.
- **`select` races `done` against `ctx.Done()`.** Whichever fires
  first decides the outcome — this is the same first-wins shape as the
  previous exercise's `Serve`, just applied to "every component
  finished" instead of "one handler finished."
- **The `ctx.Done()` branch returns `nil`, not `&result`.** This is the
  part that's easy to get wrong: the four component goroutines are
  *still running* when this branch fires — they haven't necessarily
  called `wg.Done()` yet, and some are still in the middle of writing
  to their field of `result`. Returning `&result` here would hand the
  caller a pointer to a struct that another goroutine can write to at
  any moment afterward, with no synchronization between that write and
  whatever the caller does with the pointer. Returning `nil` instead
  means there is nothing left for the caller to accidentally read
  unsynchronized.
- Each component writes to a *different* field of `result`
  (`.Basic`, `.Shipping`, `.Refund`, `.History`), so the four writer
  goroutines never race with *each other* — concurrent writes to
  disjoint fields of the same struct are not a data race under Go's
  memory model, same as concurrent writes to disjoint slice indices in
  the fan-out-fan-in exercise. That fact says nothing about reading the
  struct, though: a read that isn't ordered after every writer via
  `wg.Wait()` (or an equivalent synchronization point) races with
  whichever writer is still in flight, which is exactly what returning
  `&result` on the deadline branch would do.

## Why the still-writing goroutines don't leak, and why `result` outlives `Construct`

Two things about this design are worth being explicit about, since
they look related but are answered by two different mechanisms.

**Does bailing out early leak the four component goroutines?** No —
and this is a different situation from a classic goroutine leak. Each
component goroutine's job is just to call `defer wg.Done(); result.X =
component()` and then return; it isn't blocked on sending anywhere, so
there's no unblockable channel operation for it to get stuck on. It
runs to completion on its own schedule and exits normally — `Construct`
returning early on the `ctx.Done()` branch doesn't stop that goroutine,
it just stops *waiting* for it, the same distinction as the previous
exercise's `Serve`/`handler` relationship. The `done`-closing goroutine
is the same story: it calls `wg.Wait()` (which will eventually return,
once every component finishes) and then closes `done` — closing a
channel nobody is receiving from anymore is not an error, so that
goroutine also exits cleanly on its own.

**If `Construct` has already returned, why doesn't `result` get garbage
collected out from under the still-running goroutines?** Because Go's
garbage collector is *reachability-based*, not *scope-based*. `result`
is declared as a local variable inside `Construct`, but each of the
four component goroutines' closures captures `&result` (implicitly,
via `result.Basic = basic()` etc.) — so as long as any of those
goroutines is still alive, `result` is still reachable from a live GC
root, regardless of whether the function that originally declared it
has returned. The Go compiler's escape analysis is what decides this
at compile time: because `result`'s address is captured by closures
that outlive the function (their goroutines aren't guaranteed to exit
before `Construct` returns), `result` is compiler-allocated on the
*heap*, not the stack, specifically so it survives after `Construct`
returns. You can see this directly:

```
$ go build -gcflags="-m" -o /dev/null ./32-fanout-deadline-race/ 2>&1 | grep "moved to heap"
32-fanout-deadline-race/main.go:73:6: moved to heap: result
32-fanout-deadline-race/main.go:74:6: moved to heap: wg
```

(`wg` moves to heap for the same reason — the `done`-closing goroutine's
closure calls `wg.Wait()`, capturing its address too.)

If none of the four closures captured `result`'s address — say, if
each component instead returned its value through a channel and
`Construct` assembled the struct itself, entirely within its own stack
frame, after all four sends were received — the compiler could safely
stack-allocate it instead, since nothing outliving the function would
ever reference it. The moment a value's address is captured by
something with a longer lifetime than the function that created it
(a goroutine, a channel, a returned closure), it has to go on the heap;
that's the whole rule escape analysis is checking for.

## Key takeaways

- `wg.Wait()` can't be selected on directly — racing it against a
  deadline needs a helper goroutine that calls `wg.Wait()` and then
  closes a `done` channel, which can.
- Disjoint-field writes to a shared struct across goroutines are safe
  without a mutex — but that only covers the writes. Reading the
  struct before a proper happens-before point (`wg.Wait()` returning,
  or equivalently `done` closing) races with whichever writer hasn't
  finished yet, so the bail-out path must return `nil`, not a pointer
  into the struct still being written.
- Returning early from `Construct` doesn't stop the component
  goroutines — it just stops the caller from waiting on them. They run
  to completion in the background regardless, the same as the
  `handler` in the previous exercise.
- A value whose address is captured by a goroutine closure that might
  outlive its enclosing function gets moved to the heap by the
  compiler's escape analysis — reachability, not lexical scope, is what
  keeps it alive, and `-gcflags="-m"` shows exactly which values that
  applies to.
