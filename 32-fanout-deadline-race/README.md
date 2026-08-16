# Racing a Fan-Out Against a Deadline

`Construct` builds a `Result` by fanning out to four independent
components - `basic`, `shipping`, `refund`, and `history` (see
`mockcomponent.go`) - concurrently, each writing into its own field of
a shared `Result`, then waiting for all four before returning it. Each
component takes no `ctx` at all: like a handler in the previous
exercise, it has no way to cooperatively notice a cancellation, and
once started it always runs for its full latency.

```
today:  basic ────┐
        shipping ─┼─▶ write result's fields ─▶ wg.Wait() ─▶ &result, nil
        refund ───┤      (concurrently)          (blocks unconditionally,
        history ──┘                               ctx never consulted)

goal:   basic ────┐
        shipping ─┼─▶ write result's fields ─▶ race: wg.Wait() vs ctx.Done()
        refund ───┤      (concurrently)                 │               │
        history ──┘                                     wg wins first   ctx wins first
                                                        │               │
                                                        &result, nil    nil, ctx.Err()
                                                                        (still-running
                                                                        components keep
                                                                        writing result -
                                                                        must not read it)
```

The current implementation fans out correctly, but then calls
`wg.Wait()` unconditionally, with no regard for `ctx`. If even one
component is slower than the caller's deadline, `Construct` blocks for
however long that component takes - the deadline is completely
ignored.

## Your task

Fix `Construct` so that it returns promptly with `ctx.Err()` (and a
`nil` `*Result`) if `ctx`'s deadline passes before every component has
finished, instead of always waiting for the slowest one regardless.
Two things to hold onto:

- The four goroutines write to *disjoint* fields of the same `Result`
  struct, so there's no data race between them - as long as nothing
  reads the struct before `wg.Wait()` has actually returned.
- If you bail out via `ctx.Done()`, the component goroutines are still
  running and still writing to `result`'s fields in the background. Do
  **not** read `result` (or return a pointer to it) on that path -
  there's no synchronization between those writes and whatever would
  be reading it. Return `nil` instead.

The function signature must stay the same:

```go
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error)
```

## Test your solution

```
go test
go test --race
```
