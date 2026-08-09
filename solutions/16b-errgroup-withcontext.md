# errgroup.WithContext: Cancel-on-First-Error — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `16b-errgroup-withcontext/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

This exercise picks up where [16](../16-errgroup-failfast) left off. `Go`/`Wait` already do everything 16 asked for — launch concurrently, track via `sync.WaitGroup`, safely capture the first error via `sync.Once` — and that part is given as already correct:

```go
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

- Derive a cancelable child `Context` from `ctx` (via `context.WithCancel`) and return it alongside a new `*Group`.
- Cancel that derived `Context` the instant the *first* task fails, via `Go`, so cooperating siblings selecting on `ctx.Done()` notice and can return early.
- Cancel that derived `Context` again — or rather, unconditionally — once `Wait` returns, even when every task succeeded, so the `Context`'s resources are never leaked.
- Stay cooperative: nothing here can forcibly kill a running goroutine. A task that never checks `ctx.Done()` keeps running to completion no matter what.

## Why the naive version is wrong

`WithContext` hands back the exact `ctx` it was given, with no derived cancelable child at all. That means:

- `Go`'s error-capture logic has nothing to cancel — even after wiring it up to *try* to cancel, there's no `cancel` field to call.
- A cooperating task selecting on `ctx.Done()` is selecting on whatever `Done()` the *caller's* context provides. If the caller passed `context.Background()` (as the exercise's own `main()` and the tests do), `Done()` never fires, ever — so the task always falls through to its own timeout instead of noticing a sibling's failure.
- Even on a fully successful run, nothing about the returned `ctx` changes state after `Wait()` — there's no resource to release because none was created.

Verified: running the current `check_test.go` against this naive `main.go` in a throwaway scratch copy fails exactly `TestFailFastCancelsSiblingContext` (`Wait took 1s; want well under 100ms`), `TestWaitCancelsContextEvenOnSuccess` (`ctx` never cancelled), and the `ctx.Err() == nil` assertion inside `TestFirstErrorAndCancelRaceSafe`. The baseline `TestGroupRunsAllTasksAndCapturesFirstError` passes regardless, since it doesn't touch `ctx` at all — the bug is entirely in the `Context` half of the type, not the error-capture half carried over from 16.

## The fix: `context.WithCancel` + calling `cancel` from both `Go` and `Wait`

```go
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

- **The `cancel` call lives inside the same `errOnce.Do` closure as the `firstErr` write.** This is what makes "first error wins" and "cancel exactly once on failure" happen atomically together — there's no separate synchronization needed to guarantee `cancel` is called exactly once from the failure path, because `sync.Once` already guarantees that for the whole closure.
- **`Wait` calls `g.cancel()` unconditionally, not just when `firstErr != nil`.** This mirrors real `errgroup.WithContext`, whose `Wait` also calls its internal cancel func regardless of outcome. `context.CancelFunc` is idempotent — calling it a second time (e.g., once from a failing `Go`, then again from `Wait`) is a documented no-op, so there's no double-cancel hazard to guard against.
- **Why `Wait` must cancel even on success:** `context.WithCancel`'s own doc comment states the `CancelFunc` must be called once the derived `Context` is no longer needed, or its resources (and, if it has a `Done()`-watching parent, the goroutine tracking that association) are not released promptly. Skipping this on the success path is exactly the mistake `go vet`'s `lostcancel` analyzer looks for in ordinary code — a `context.WithCancel` (or `WithTimeout`/`WithDeadline`) whose `cancel` isn't called on some code path.
- **This is cooperative, not preemptive, cancellation.** `Go`/`Wait` only ever close a channel (`ctx`'s `Done()`) — they have no way to stop a goroutine that isn't itself selecting on that channel. A task ignoring `ctx` entirely (like exercise 16's own demo tasks) keeps running to completion regardless; only tasks written to check `ctx.Done()` "fail fast."

**Verified**: copied this exercise into a throwaway scratch directory, confirmed the naive `main.go` fails the three tests described above, then dropped in this solution. `go vet ./...` is clean, and `go test -race -count=5 ./...` passes repeatably — including `TestFailFastCancelsSiblingContext` (via `synctest`, so the ~1s-vs-under-100ms timing assertion is exact rather than a flaky wall-clock race) and `TestWaitCancelsContextEvenOnSuccess`.

## Key takeaways

- Real `errgroup.WithContext` isn't magic preemption — it's a shared `context.CancelFunc`, called from inside the same `sync.Once` that already guards "first error wins," plus one more unconditional call from `Wait`. Nothing forcibly stops a goroutine; a task only "fails fast" if it's written to select on `ctx.Done()` in the first place.
- Guarding a side effect (`cancel()`) inside the same `sync.Once.Do` closure as a state write (`firstErr = err`) is a clean way to make two things happen atomically-together-exactly-once, without a second mutex or flag.
- `context.CancelFunc` is safe to call more than once — idiomatic code (including this solution, and real `errgroup`) relies on that to call `cancel` from both an error path and an unconditional cleanup path without needing to track whether it already ran.
- Forgetting to call a `context.WithCancel`/`WithTimeout`/`WithDeadline` cancel func on *every* return path — not just the error one — is a real, `go vet`-flagged resource leak (`lostcancel`), not just a style nit. `Wait`'s unconditional `g.cancel()` is what closes that gap here.
