# Serve Timeout Race: First-Wins Response Under a Deadline

Given is `Serve`, a small stand-in for the server side of an RPC
framework: it's handed a `ctx` carrying the caller's deadline and a
`handler` that does the real work, and it's supposed to return by that
deadline no matter what the handler does.

The catch is the handler's signature: `func() (string, error)` - it
takes no `ctx` at all. That's deliberate. It represents legacy or
simply synchronous business logic that has no way to cooperatively
notice a cancellation, the same way a plain `time.Sleep` or a tight
CPU loop can't. `Serve` can't reach into it and stop it early; all it
can do is stop *waiting* for it once the deadline passes, and hand the
caller a timeout error instead of the handler's eventual result.

```
today (broken):                        goal:
Serve(ctx, handler)                    Serve(ctx, handler)
      │                                      │
      ▼                                      ├──▶ handler runs on its own,
  handler() blocks Serve                     │    unattended
  however long it takes                      ▼
      │                                 whichever lands first wins:
      ▼                                  handler finishes → return its (value, err)
  return whatever handler                 ctx's deadline passes → return ctx.Err()
  returns - ctx never read
                                        the loser keeps running to completion
                                        with nobody left listening
```

## Your task

Fix `Serve` so that it returns by `ctx`'s deadline (with `ctx.Err()`)
if the handler hasn't finished by then, without ever blocking on the
handler for longer than that - while still letting the handler's real
result through if it finishes first. The function signature must stay
exactly the same:

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error)
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
