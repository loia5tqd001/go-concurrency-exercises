# Serve Timeout Race: First-Wins Response Under a Deadline — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `31-serve-timeout-race/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`Serve` stands in for the server side of an RPC framework: it's handed
a `ctx` carrying the caller's deadline and a `handler` that does the
real work, and it's supposed to return by that deadline no matter what
the handler does.

The handler's signature is deliberately `func() (string, error)` — no
`ctx` parameter at all. That represents legacy or simply synchronous
business logic with no way to cooperatively notice a cancellation, the
same way a plain `time.Sleep` or a tight CPU loop can't. `Serve` can't
reach into a call like that and stop it early; all it can control is
how long *it* waits before giving up on it.

The given implementation ignores that entirely:

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
	return handler()
}
```

The task is to fix `Serve` so it returns by `ctx`'s deadline (with
`ctx.Err()`) if the handler hasn't finished by then, without ever
blocking on the handler longer than that — while still returning the
handler's real result if it finishes first. The signature —
`func Serve(ctx context.Context, handler func() (string, error)) (string, error)` —
must stay exactly the same.

## Why the naive version is wrong

`ctx` is accepted as a parameter but never read. So `Serve` always
takes exactly as long as `handler` takes, and a caller's deadline has
no effect whatsoever:

```
--- FAIL: TestServeRespectsDeadlineWhenHandlerIgnoresCtx (0.00s)
    check_test.go:64: Serve returned no error; want an error from the 100ms deadline expiring (took 500ms)
```

`TestServeReturnsHandlerResultWithAmpleDeadline` still passes against
the naive version — with a 2s deadline and only 50ms of real handler
work, nothing ever actually times out, so the bug doesn't manifest on
the happy path. That's the same trap as in the context-cancellation
exercise: code that ignores its `ctx` parameter can look correct until
something upstream is slow or a caller sets a tight deadline.

## Approach 1: Race the handler against `ctx.Done()` via a buffered result channel

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
	type result struct {
		value string
		err   error
	}
	resCh := make(chan result, 1)

	go func() {
		value, err := handler()
		resCh <- result{value, err}
	}()

	select {
	case res := <-resCh:
		return res.value, res.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
```

Walking through the pieces:

- **`handler` runs in its own goroutine**, started unconditionally.
  Since it has no `ctx` parameter, this is the *only* way to stop
  waiting on it without stopping it — you cannot reach inside a
  synchronous, non-context-aware function and interrupt it. It keeps
  running to completion regardless of what `Serve` decides to do.
- **`select` races two outcomes**: the handler goroutine delivering a
  result on `resCh`, versus `ctx.Done()` firing. Whichever happens
  first is what `Serve` returns — this is the "first-wins" pattern
  that a real RPC server's timeout enforcement uses internally
  (an independent timer racing the handler, with only one side's
  result ever making it back to the caller).
- **`resCh` is buffered with capacity 1.** This is not a stylistic
  choice — it's what prevents a goroutine leak. If the deadline wins
  the race, `Serve` returns immediately and nothing is left to receive
  from `resCh` ever again. Without the buffer, the handler goroutine's
  send (`resCh <- result{...}`) would block forever once its `time.Sleep`
  finally elapses, since nobody is listening — a permanently blocked,
  leaked goroutine. With the buffer, that send always succeeds
  instantly, the goroutine exits normally, and the buffered value just
  sits there unread until it's garbage collected along with the
  channel itself.
- The handler's own result is silently discarded when the deadline
  wins — there is no way to tell it "actually, forget what you were
  about to compute." That's an inherent limitation of racing an
  uncooperative synchronous function, not a shortcoming of this fix:
  the fix's job is only to stop the *caller* from waiting on it, not
  to stop the handler.

Buffering to exactly the number of values that will ever be sent (here,
always exactly one) is the right call whenever the sender and the
"maybe nobody's listening anymore" receiver don't share a common
cancellation signal to coordinate a `select`-based send instead — which
is precisely this case, since `handler` has no `ctx` to select against
in the first place.

## Key takeaways

- A function ignoring a `ctx` parameter it accepts is a correctness bug
  that only shows up once something is actually slow relative to the
  deadline — the happy-path test here passes against the fully broken
  naive version, exactly as it does in the context-cancellation
  exercise.
- You cannot forcibly stop a goroutine running synchronous,
  non-context-aware code. All `Serve` can do is stop *waiting* for it
  and return control to its own caller — the handler itself keeps
  running in the background to completion regardless.
- Racing a handler goroutine against `ctx.Done()` via `select` is how a
  deadline gets enforced on top of code that can't enforce it on its
  own. This is the same shape real RPC frameworks use server-side: an
  independent timer (or here, `ctx.Done()`) races the handler, and only
  the first one to finish gets to produce the response.
- The result channel must be buffered to the exact number of sends
  that will ever happen (one, here) whenever the sender has no
  cancellation signal of its own to `select` against — otherwise the
  losing send blocks forever and the goroutine leaks.
