# Semaphore: Bounding Parallelism Against a Rate-Limited API

`FetchAll` fetches every request in a list from `FlakyAPI.Call` (see
`mockapi.go`), a mock downstream service that only tolerates a small
number of concurrent in-flight calls before it starts rejecting the
rest with `ErrTooManyConcurrentRequests`.

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

Right now `FetchAll` fires off every request at once with no
concurrency limit whatsoever, so as soon as there are more requests
than the API can handle simultaneously, it regularly blows past the
API's concurrency budget and gets a pile of errors back.

Your task is to bound how many requests are in flight at once by
implementing your own counting semaphore from scratch, using a
buffered channel of `struct{}` - do not import
`golang.org/x/sync/semaphore` or any other pre-built semaphore, the
whole point of this exercise is to build one yourself.

Pick a fixed cap that is strictly less than the API's own
`maxConcurrent` budget (`main.go` constructs it with `NewFlakyAPI(3)`),
giving yourself headroom rather than riding the exact edge of it. At
the same time, requests must still be dispatched concurrently rather
than one at a time - the point of a semaphore is to cap concurrency,
not eliminate it. The function signature must stay the same:

```go
func FetchAll(api *FlakyAPI, reqs []string) []string
```

so that it remains a drop-in replacement for the naive version below.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
