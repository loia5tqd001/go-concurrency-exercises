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

The current implementation ignores `ctx` entirely: it calls
`handler()` directly and returns whatever it gets, however long that
takes. A caller's deadline never has any effect.

Your task is to fix `Serve` so that it returns by `ctx`'s deadline
(with `ctx.Err()`) if the handler hasn't finished by then, without
ever blocking on the handler for longer than that - while still
letting the handler's real result through if it finishes first. The
function signature must stay exactly the same:

```go
func Serve(ctx context.Context, handler func() (string, error)) (string, error)
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
