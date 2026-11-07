# errgroup.WithContext: Cancel-on-First-Error

This exercise follows [16](../16-errgroup-failfast). Its `Group`
already has a working `Go` and `Wait`. `Go` starts tasks at the same
time and tracks them with `sync.WaitGroup`. `Wait` captures the first
error with `sync.Once`.

The new part is `WithContext`. It should work like
`golang.org/x/sync/errgroup.WithContext`. It returns a `*Group` and a
`context.Context`. The context is canceled when any task fails.
Other tasks can check `ctx.Done()` and stop early. The context is also
canceled when `Wait` returns, even if every task succeeds. This
avoids leaving its resources open.

Today, `WithContext` returns `ctx` unchanged:

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

Your task is to fix `WithContext` and connect it to the other
methods:

- `WithContext(ctx context.Context) (*Group, context.Context)` creates
  a cancelable child `Context` with `context.WithCancel`. Return it
  with a new `*Group`.
- `Go(f func() error)` still starts `f` at the same time and captures
  the first error. When it captures that error, it also cancels the
  child context.
- `Wait() error` still waits for every task and returns the first
  error. Before it returns, it cancels the child context, even if
  every task succeeded.

Cancellation needs cooperation, just like real `errgroup`. It cannot
force a goroutine to stop. A task that does not check `ctx.Done()`
runs until it finishes. Fail-fast only works when each task checks the
context and returns early.

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
