# Semaphore: Bounding Parallelism Against a Rate-Limited API

`FetchAll` sends each request to `FlakyAPI.Call` (see `mockapi.go`).
The mock API allows only a few calls at the same time. If more calls
run, it returns `ErrTooManyConcurrentRequests` for the rest.

```
today (broken):                     goal:
12 requests, fired all at once      12 requests, gated to N in flight
   │   │   │   │   │  ...              │   │   │   │   │  ...
   ▼   ▼   ▼   ▼   ▼                   ▼   ▼   ▼   ▼   ▼
api.Call ×12 at once - blows        [ N slots ] - the rest queue here
past the API's budget, most                │
come back ERROR                            ▼
                                     api.Call, one per slot - none ever
                                     rejected, still running in parallel
```

Today, `FetchAll` starts every request at once. When there are more
requests than the API allows, many calls fail.

Your task is to limit how many requests run at once. Build your own
counting semaphore with a buffered channel of `struct{}`. Do not import
`golang.org/x/sync/semaphore` or another semaphore package. The point
is to build the semaphore yourself.

Choose a fixed cap below the API's `maxConcurrent` budget. `main.go`
uses `NewFlakyAPI(3)`, so your cap should leave some room. Requests
must still run in parallel. The semaphore limits how many run at once.
It must not make all requests run one by one.

The function signature must stay the same:

```go
func FetchAll(api *FlakyAPI, reqs []string) []string
```

so it can replace the naive version below without caller changes.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
