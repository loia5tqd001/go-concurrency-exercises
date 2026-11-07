# errgroup.WithContext: Stop after the first error

> **Spoiler warning.** This file has a full solution for `16b-errgroup-withcontext/`. Try the exercise first. Come back if you get stuck.

## The problem

This exercise builds on [16](../16-errgroup-failfast). The supplied `Go` and `Wait` code already works. It starts tasks, uses `sync.WaitGroup`, and records the first error with `sync.Once`.

```go {8}
type Group struct {
	wg       sync.WaitGroup
	errOnce  sync.Once
	firstErr error
}

func WithContext(ctx context.Context) (*Group, context.Context) {
	return &Group{}, ctx
}

func (g *Group) Go(f func() error) {
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := f(); err != nil {
			g.errOnce.Do(func() {
				g.firstErr = err
			})
		}
	}()
}

func (g *Group) Wait() error {
	g.wg.Wait()
	return g.firstErr
}
```

`WithContext` must:

- Create a child `Context` with `context.WithCancel`. Return it with a new `*Group`.
- Cancel the child when the first task fails. A sibling can then stop after it sees `ctx.Done()`.
- Always cancel again after `Wait` returns, even when every task succeeds. This releases resources.
- Stay cooperative. The code cannot kill a task. A task that ignores `ctx.Done()` runs to completion.

## Why the naive version is wrong

`WithContext` returns the same `ctx` it receives. It creates no cancelable child.

- `Go` has no `cancel` field to call when a task fails.
- A task waits on the caller's context. The exercise's `main()` passes `context.Background()`, so `Done()` never fires.
- A task then falls back to its own timeout. It never sees a sibling fail.
- A successful run leaves the returned `ctx` unchanged. No resource exists to release.

I ran `check_test.go` against the naive `main.go` in a scratch copy. Three checks fail:

- `TestFailFastCancelsSiblingContext` reports `Wait took 1s; want well under 100ms`.
- `TestWaitCancelsContextEvenOnSuccess` reports that `ctx` never cancels.
- `TestFirstErrorAndCancelRaceSafe` fails its `ctx.Err() == nil` check.

`TestGroupRunsAllTasksAndCapturesFirstError` passes because it does not use `ctx`. The bug is only in the context half of the type.

`TestWithContextDerivesFromParent` also passes against the naive code. Returning the same context makes that test trivially true.

The test catches another mistake: creating the child from `context.Background()` instead of the passed `ctx`.

Every other test calls `WithContext(context.Background())`. The parent test passes a value and its own cancellation. Only a real child passes both checks.

## The fix: `context.WithCancel` + calling `cancel` from both `Go` and `Wait`

```go {20,32,42}
package main

import (
	"context"
	"sync"
)

// Group runs a collection of tasks, started via Go, and collects the
// first error (if any) returned by them once every task has finished.
type Group struct {
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	errOnce  sync.Once
	firstErr error
}

// WithContext returns a new Group alongside a Context derived from
// ctx, cancelled the moment any task fails or once Wait returns.
func WithContext(ctx context.Context) (*Group, context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	return &Group{cancel: cancel}, ctx
}

// Go launches f in its own goroutine and returns immediately.
func (g *Group) Go(f func() error) {
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := f(); err != nil {
			g.errOnce.Do(func() {
				g.firstErr = err
				g.cancel()
			})
		}
	}()
}

// Wait blocks until every task started via Go has finished, cancels
// the derived Context, and returns the first error encountered.
func (g *Group) Wait() error {
	g.wg.Wait()
	g.cancel()
	return g.firstErr
}
```

Design notes:

- The `cancel` call sits inside the same `errOnce.Do` closure as `firstErr = err`.
- `sync.Once` makes both actions run exactly once on the failure path.
- No second lock is needed for this pair.
- `Wait` does not check `firstErr != nil` before it calls `g.cancel()`. Real `errgroup.WithContext` does the same.
- Every `Wait()` call cancels the child, whether tasks failed or all succeeded.
- `context.CancelFunc` is idempotent. A second call is a safe no-op.
- `context.WithCancel`, `WithTimeout`, and `WithDeadline` say to call `CancelFunc` when the child is no longer needed.
- Skipping this call can keep resources and the parent watcher alive.
- `go vet` reports this problem as `lostcancel`.
- Cancellation is cooperative. `Go` and `Wait` only close the `Done()` channel.
- A task that never selects on that channel keeps running. Exercise 16's demo tasks do this.

I tested the solution in a scratch copy. The naive `main.go` fails the three checks above. The solution passes these commands:

- `go vet ./...`
- `go test -race -count=20 ./...`

The passing checks include `TestFailFastCancelsSiblingContext`, `TestWaitCancelsContextEvenOnSuccess`, and `TestWithContextDerivesFromParent`. The fail-fast test uses `synctest`, so its timing check is exact.

I also changed `context.WithCancel(ctx)` to `context.WithCancel(context.Background())`. The other four tests still pass. Only `TestWithContextDerivesFromParent` fails. This shows why that test exists.

## Key takeaways

- `errgroup.WithContext` does not use magic preemption. It shares a `context.CancelFunc`.
- The first error path calls `cancel` inside the same `sync.Once` that records the error.
- `Wait` also calls `cancel`, with no condition.
- Nothing can force a goroutine to stop. A task must select on `ctx.Done()` to fail fast.
- Keep `cancel()` in the same `sync.Once.Do` closure as the `firstErr` write. Both actions then run exactly once.
- `context.CancelFunc` is safe to call many times. This solution and real `errgroup` rely on that.
- Call the cancel func on every return path. Do not call it only after an error.
- Missing a cancel call is a resource leak. `go vet` reports it as `lostcancel`.
- `Wait`'s unconditional `g.cancel()` closes that gap here.
