# errgroup.WithContext: Cancel-on-First-Error

This exercise picks up right where [16](../16-errgroup-failfast) left off. Given is a `Group` whose `Go`/`Wait` pair already does everything 16 asked for — `Go` launches tasks concurrently, tracked via an internal `sync.WaitGroup`, and safely captures the first error via `sync.Once`. What's new here is `WithContext`, meant to mimic `golang.org/x/sync/errgroup.WithContext`: it should hand back a `*Group` alongside a `context.Context` that gets cancelled the instant any task fails, so cooperating siblings can notice via `ctx.Done()` and stop early instead of running to completion regardless — and that also gets cancelled once `Wait` returns, even if every task succeeded, so its resources are never leaked.

The current `WithContext` just hands back the same `ctx` it was given, completely unchanged:

```
today:  WithContext(ctx) ──▶ ctx, unchanged
        task 0 fails    ──▶ firstErr set ── nothing cancelled
        task 1..4  ── select ctx.Done() ── never fires ──▶ each burns its full 1s

goal:   WithContext(ctx) ──▶ child, cancel := context.WithCancel(ctx)
        task 0 fails    ──▶ firstErr set + cancel() ──┐
        task 1..4  ── select ctx.Done() ◀─────────────┘
                                       └──▶ return in ms, not 1s
        Wait()          ──▶ cancel() unconditionally ──▶ Context released even on success
```

Your task is to fix `WithContext` and wire the two other methods so that:

- `WithContext(ctx context.Context) (*Group, context.Context)` derives a cancelable child `Context` (via `context.WithCancel`) and returns it alongside a new `*Group`.
- `Go(f func() error)` keeps launching `f` concurrently and capturing the first error exactly as before, but now also cancels the derived `Context` the instant that first error is captured.
- `Wait() error` keeps waiting for every task and returning the first error exactly as before, but now also cancels the derived `Context` before returning, even when every task succeeded.

One thing to hold onto: this is **cooperative** cancellation, same as real `errgroup`. Nothing here can forcibly stop a running goroutine — a task that never selects on `ctx.Done()` keeps running to completion regardless of what `Go`/`Wait` do. "Fail fast" only works for tasks that are themselves written to notice `ctx` and return early.

The signatures must be:

```go
func WithContext(ctx context.Context) (*Group, context.Context)
func (g *Group) Go(f func() error)
func (g *Group) Wait() error
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
