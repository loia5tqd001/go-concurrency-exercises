# Serve Timeout Race: First-Wins Response Under a Deadline

`Serve` is a small stand-in for the server side of an RPC framework. It
gets a `ctx` with the caller's deadline and a `handler` that does the
work. It must return by the deadline, whatever the handler does.

The handler signature is `func() (string, error)`. It takes no `ctx`.
This is deliberate. It stands for old or synchronous logic that cannot
notice cancellation. A plain `time.Sleep` or tight CPU loop behaves the
same way.

`Serve` cannot stop the handler early. It can stop waiting after the
deadline. It then returns a timeout error instead of the later result.

```
today (broken):                        goal:
Serve(ctx, handler)                    Serve(ctx, handler)
      │                                      │
      ▼                                      ├──▶ handler runs on its own,
  handler() blocks Serve                     │    unattended
  however long it takes                      ▼
      │                                 whichever lands first wins:
      ▼                                  handler finishes → return its (value, err)
  return whatever handler                ctx's deadline passes → return ctx.Err()
  returns - ctx never read
                                        the loser keeps running to completion
                                        with nobody left listening
```

## Your task

Fix `Serve`. If the handler has not finished by the deadline, return
`ctx.Err()`. Do not wait longer. If the handler finishes first, return
its real result. Keep the signature exactly the same:

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error)
```

## Test your solution

The tests must pass:

```
go test
go test --race
```
