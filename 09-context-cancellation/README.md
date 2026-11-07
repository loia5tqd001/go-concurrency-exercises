# Context Cancellation & Propagation: A Request Chain That Ignores Its Deadline

`HandleRequest` calls `CallLayerA`, `CallLayerB`, and `CallLayerC` in
order. See `mocklayers.go`. Each layer takes about 300 ms. Each layer
watches the context it receives.

It returns early with `ctx.Err()` when that context ends.

The current code ignores `ctx`. It gives each layer a new background
context. A timeout or cancellation never reaches the layers. Each
layer always runs for 300 ms.

```
today (broken):                      goal (fixed):
layers get Background(), 200ms       layers get ctx, 200ms deadline
deadline ignored                     reaches every layer call
  │                                    │
  ├─ A: full 300ms                     ├─ A: ctx.Done() fires at 200ms
  ├─ B: full 300ms                     ├─ B: skipped, chain stopped
  └─ C: full 300ms                     └─ C: skipped, chain stopped
  ▼                                    ▼
900ms, "ABC", no error               ~200ms, returns DeadlineExceeded
                                      (a 350ms cancel mid-B gives
                                      Canceled instead, C still skipped)
```

Pass `ctx` into each layer. Do not use `context.Background()`. Then a
cancel or deadline can stop the chain early.

The function signature must stay exactly the same:

```go
func HandleRequest(ctx context.Context) (string, error)
```

## Test your solution

Pass these tests:

```
go test
go test --race
```
