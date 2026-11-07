# Racing a Fan-Out Against a Deadline

`Construct` builds a `Result` from four components. The components are
`basic`, `shipping`, `refund`, and `history`. See `mockcomponent.go`.
They run concurrently. Each writes to its own field of a shared
`Result`. `Construct` waits for all four.

Each component takes no `ctx`. Like the handler in the previous
exercise, it cannot notice cancellation. Once started, it runs for its
full latency.

```
today:  basic ────┐
        shipping ─┼─▶ write result's fields ─▶ wg.Wait() ─▶ &result, nil
        refund ───┤      (concurrently)          (blocks unconditionally,
        history ──┘                              ctx never consulted)

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

Today, `Construct` fans out correctly. Then it always calls `wg.Wait()`
and ignores `ctx`. If one component is slower than the deadline,
`Construct` waits for it. The deadline does nothing.

## Your task

Fix `Construct`. If the deadline passes before every component finishes,
return `ctx.Err()` and a `nil` `*Result`. Do not always wait for the
slowest component. Two details matter:

- The four goroutines write to different fields of the same `Result`.
  They do not race with each other. This is true only when no code reads
  the struct before `wg.Wait()` returns.
- If `ctx.Done()` wins, the component goroutines are still running. They
  still write to `result` in the background. Do not read `result` or
  return its pointer. There is no synchronization with those writes.
  Return `nil`.

Keep the signature the same:

```go
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error)
```

## Test your solution

```
go test
go test --race
```
