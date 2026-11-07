# Racing Fan-Out Work Against a Deadline - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `32-fanout-deadline-race/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

`Construct` calls four independent components at once: `basic`, `shipping`, `refund`, and `history`. Each writes to its own field in a shared `Result`. `Construct` waits for all four.

None of the components takes a `ctx`. They represent synchronous work, such as a downstream call or a computation. They cannot notice cancellation after they start.

The given code fans out correctly, but always waits for every component:

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

When the deadline passes, `Construct` must return quickly with `ctx.Err()`. It must also return a `nil` `*Result`.

It must not read `result` on the early-return path. Other components may still write to it. Keep the signature unchanged: `func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error)`.

## Why the naive version is wrong

`wg.Wait()` waits for every component. The code accepts `ctx`, but never reads it.

In the test, `history` takes 500ms and the caller allows 100ms. `Construct` still takes 500ms:

```
--- FAIL: TestConstructRespectsDeadlineWhenAComponentStalls (0.00s)
    check_test.go:76: Construct returned no error; want an error from the 100ms deadline expiring (took 500ms)
```

`TestConstructReturnsAllFieldsWithAmpleDeadline` still passes. It uses a 2s deadline and 20ms components. Nothing times out.

A production fan-out has the same risk. It passes normal tests. A slow branch makes it miss the caller's deadline. The caller may already have timed out and moved on.

## Approach 1: Race `wg.Wait()` against `ctx.Done()`, and don't touch `result` on the losing branch

```go {11,13,14,21}
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

How it works:

- **You cannot use `wg.Wait()` in `select`.** It is not a channel operation.
- **Use a helper goroutine.** It calls `wg.Wait()` and closes a `done` channel.
- **Race `done` against `ctx.Done()`.** The first event wins.
- **Return `nil` from the deadline branch.** Components may still write to `result`. Returning `&result` exposes unsynchronized writes.
- **Different fields do not race with each other.** The writes are `.Basic`, `.Shipping`, `.Refund`, and `.History`. Go allows concurrent writes to separate fields.
- **Reading is different.** A read must happen after all writes. `wg.Wait()` or an equivalent signal provides that order.

## Approach 2: Skip the `WaitGroup` — let each component signal on a channel sized to exactly four

Approach 1 needs a helper because you cannot select on `wg.Wait()`. This version uses one shared channel. Each component sends one completion signal:

```go {3,10,12,13,14}
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
	var result Result
	done := make(chan struct{}, 4)

	go func() { result.Basic = basic(); done <- struct{}{} }()
	go func() { result.Shipping = shipping(); done <- struct{}{} }()
	go func() { result.Refund = refund(); done <- struct{}{} }()
	go func() { result.History = history(); done <- struct{}{} }()

	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return &result, nil
}
```

This version has no `sync.WaitGroup` and no helper goroutine. Each component signals directly. `Construct` counts four signals.

Two details make it equivalent to Approach 1:

- **Buffer `done` to exactly 4.** This matches the `resCh` buffer of 1 in `31-serve-timeout-race`.
- **Use the exact send count.** If the deadline wins, unfinished components still send later. An unbuffered channel would block them forever.
- **Four receives create the same ordering as `close(done)`.** Each receive from `<-done` pairs with one `done <- struct{}{}` send. A send happens after its component writes its field.
- **Read `result` after all four receives.** Then every write happens before the read. This gives the same order as `wg.Wait()`.

Approach 1 uses the standard tool for waiting on a fixed group. It keeps the count inside `sync.WaitGroup`.

Approach 2 removes the helper goroutine and the `sync` import. It adds a hand-written count, `i < 4`. That count must match the number of `go func` statements.

Add a fifth component later and Approach 1 needs one `wg.Add(4)` change. Approach 2 needs changes to the loop bound and buffer size.

## Why the still-writing goroutines don't leak, and why `result` outlives `Construct`

This section explains Approach 1. Approach 2 has the same ordering logic. It has no `wg` to move to the heap.

This design raises two common questions. Two different mechanisms answer them.

**Does early return leak the four component goroutines?** No. Each component calls `defer wg.Done(); result.X = component()`. It calls `wg.Done()` through `defer`. It does not block on a send. It finishes and exits.

`Construct` stops waiting. It does not stop the components. This matches the `Serve` and `handler` relationship in the previous exercise.

The `done` helper also exits. It waits for all components, then closes `done`. Closing a channel with no receiver is still valid.

**Why does `result` remain alive after `Construct` returns?** Go's garbage collector uses reachability, not lexical scope.

Each component closure captures `&result` through code such as `result.Basic = basic()`. A live goroutine keeps that value reachable.

Escape analysis sees that `result` outlives `Construct`. It moves the value to the heap. Check it with `-gcflags="-m"`:

```
$ go build -gcflags="-m" -o /dev/null ./32-fanout-deadline-race/ 2>&1 | grep "moved to heap"
32-fanout-deadline-race/main.go:73:6: moved to heap: result
32-fanout-deadline-race/main.go:74:6: moved to heap: wg
```

`wg` moves to the heap for the same reason. The `done` helper captures its address.

Suppose each component returned its value through a channel. `Construct` could then build `result` after the receives. Nothing would capture its address, so it could stay on the stack.

Capture an address in a goroutine, channel, or returned closure, and the value may outlive its function. Escape analysis then moves it to the heap.

## Key takeaways

- You cannot select on `wg.Wait()`. Use a helper goroutine and a `done` channel.
- You can also skip `WaitGroup`. Buffer one channel to the exact sender count and count the receives.
- Different-field writes are safe. Reading before all writes finish is not.
- Return `nil` on the deadline path. Do not return a pointer while writers may still run.
- Early return stops waiting. It does not stop the components.
- Escape analysis moves captured values to the heap. Reachability keeps them alive.
