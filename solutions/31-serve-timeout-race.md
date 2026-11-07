# Serve Timeout Race: Return the First Result Before the Deadline - Suggested Solutions

> **Spoiler warning.** This file has the full solution for `31-serve-timeout-race/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

`Serve` represents the server side of an RPC framework. It receives a `ctx` with the caller's deadline. It also receives a `handler` that does the work. It must return by the deadline.

The handler signature is `func() (string, error)`. It has no `ctx`. It represents old or synchronous code that cannot notice cancellation. A plain `time.Sleep` or CPU loop behaves the same way.

`Serve` cannot stop that code. It can only control how long it waits.

The given code ignores the deadline:

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
	return handler()
}
```

`Serve` must return `ctx.Err()` when the deadline passes. It must return the handler's real result if that arrives first. It must not wait past the deadline.

Keep the signature unchanged: `func Serve(ctx context.Context, handler func() (string, error)) (string, error)`.

## Why the naive version is wrong

The code accepts `ctx` but never reads it. `Serve` always waits as long as the handler. The caller's deadline has no effect:

```
--- FAIL: TestServeRespectsDeadlineWhenHandlerIgnoresCtx (0.00s)
    check_test.go:64: Serve returned no error; want an error from the 100ms deadline expiring (took 500ms)
```

`TestServeReturnsHandlerResultWithAmpleDeadline` still passes. It uses a 2s deadline and 50ms of handler work. Nothing times out on the happy path.

This matches the context-cancellation trap. Code that ignores `ctx` can look correct until a caller sets a tight deadline.

## Approach 1: Race the handler against `ctx.Done()` via a buffered result channel

```go {6,14,16}
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

How it works:

- **Run `handler` in its own goroutine.** It has no `ctx`, so `Serve` cannot interrupt it. This only lets `Serve` stop waiting.
- **Race two results with `select`.** One is a value on `resCh`. The other is `ctx.Done()`. The first result wins.
- **Buffer `resCh` with capacity 1.** The handler sends once with `resCh <- result{...}`. If the deadline wins, no receiver remains. Without the buffer, that send blocks forever.
- **The buffer prevents a goroutine leak.** The handler sends once, even if nobody reads the value. The garbage collector can then reclaim the value with the channel.
- **Discard a late handler result.** `Serve` cannot cancel a synchronous function. It can only stop waiting for it. The handler still runs to completion.

The handler sends exactly once. Buffer the channel to that exact size when the sender has no cancellation signal. A `select`-based send would need such a signal.

## Key takeaways

- Ignoring `ctx` is a correctness bug. A normal test may pass, but a tight deadline exposes it.
- You cannot forcibly stop synchronous code with no context. `Serve` can only stop waiting.
- Race the handler with `ctx.Done()` in a `select`. The first result wins.
- Buffer a result channel to the exact send count when the sender has no cancellation signal. Otherwise, the send leaks a goroutine.
