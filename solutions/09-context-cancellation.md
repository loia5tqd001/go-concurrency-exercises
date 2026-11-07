# Context Cancellation & Propagation: A Request Chain That Ignores Its Deadline — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `09-context-cancellation/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`HandleRequest` calls `CallLayerA`, `CallLayerB`, and `CallLayerC` in
order. They are in `mocklayers.go`. It joins their results. The caller's
`ctx` must control the chain. A canceled or expired context must stop the
work quickly.

Each layer uses `callLayer` in `mocklayers.go`. It waits with `select`
for `LayerLatency` or `ctx.Done()`. It returns early with `ctx.Err()`
when the context ends. This only works if `HandleRequest` passes the
real `ctx`:

```go {2,7,12}
func HandleRequest(ctx context.Context) (string, error) {
	a, err := CallLayerA(context.Background())
	if err != nil {
		return "", err
	}

	b, err := CallLayerB(context.Background())
	if err != nil {
		return "", err
	}

	c, err := CallLayerC(context.Background())
	if err != nil {
		return "", err
	}

	return a + b + c, nil
}
```

Your task:

1. Pass `ctx` to each layer. Do not pass `context.Background()`.
2. Stop when `ctx` ends or a layer fails.

The signature must stay exactly the same:
`func HandleRequest(ctx context.Context) (string, error)`.

## Why the naive version is wrong

Every layer gets `context.Background()`. That context never ends and has
no deadline. The caller's timeout or cancellation cannot reach a layer.
Each layer runs for `LayerLatency`, 300ms. The full chain takes about
`3 * LayerLatency`, or 900ms:

```
--- FAIL: TestHandleRequestRespectsTimeout (0.00s)
    check_test.go:60: HandleRequest returned no error; want an error from the 200ms timeout expiring (took 900ms)
--- FAIL: TestHandleRequestCancelledMidway (0.00s)
    check_test.go:112: HandleRequest returned no error after cancellation; want an error
    check_test.go:117: HandleRequest took 900ms to return after cancellation, want well under 500ms - looks like it kept running later layers instead of giving up promptly once ctx was cancelled
```

`TestHandleRequestSucceedsWithAmpleTimeout` still passes. Its 2s timeout
is longer than the 900ms of work. The bug appears only under a tight
deadline or cancellation.

There is only one defect: wrong context. The existing `if err != nil`
checks already work. They follow
`if err != nil { return "", err }`. With `context.Background()`, a layer
never sees a canceled context. The checks never fire. Passing `ctx`
instead is enough. The extra checks in Approach 1 are optional
safeguards.

## Approach 1: Propagate `ctx`, check for done/failure between each layer

```go {6,15,24}
func HandleRequest(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	a, err := CallLayerA(ctx)
	if err != nil {
		return "", err
	}

	if err := ctx.Err(); err != nil {
		return "", err
	}

	b, err := CallLayerB(ctx)
	if err != nil {
		return "", err
	}

	if err := ctx.Err(); err != nil {
		return "", err
	}

	c, err := CallLayerC(ctx)
	if err != nil {
		return "", err
	}

	return a + b + c, nil
}
```

How the fix works:

- Each layer gets the real `ctx`, not `context.Background()`. The layer
  checks `ctx.Done()`, so a timeout can stop it early.
- The `if err != nil { return "", err }` check stops the chain after a
  failure. When a layer times out, `callLayer` returns `"", ctx.Err()`.
  Later layers do not start.
- The extra `ctx.Err()` checks also catch a context that ends between
  calls. The three context swaps alone pass the suite. These checks add
  safety.
- Returning `err` gives `ctx.Err()` for a timeout or cancel. This gives
  `context.DeadlineExceeded` or `context.Canceled`.
- `TestHandleRequestRespectsTimeout` checks
  `errors.Is(err, context.DeadlineExceeded)`.

The chain is sequential. Join a layer result only after the previous
layer finishes. Pass one `ctx` through all calls. Stop when work ends or
fails.

Do not run all three layers at once. That changes the exercise. A
fan-out with `errgroup` would also break
`TestHandleRequestCancelledMidway`. That test expects layer B to still
run at 350ms. All three would finish in one 300ms `LayerLatency` window.

## Key takeaways

- Do not pass `context.Background()` when the function already has a
  `ctx`. The function looks context-aware but ignores the caller.
- A context-aware layer needs the real context. `callLayer` was correct.
  `HandleRequest` passed the wrong context.
- Check `ctx.Err()` or the previous error between calls. Return at once.
  This stops more work after a deadline.
- A passing happy-path test does not prove context handling.
  `TestHandleRequestSucceedsWithAmpleTimeout` passes while the code is
  broken. Use a tight deadline or a mid-chain cancel.
