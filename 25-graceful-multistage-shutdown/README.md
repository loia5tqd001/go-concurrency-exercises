# Graceful Multi-Stage Shutdown: Knowing When a Worker Pool Has REALLY Finished

Given is `Start`, which launches a small, fixed-size pool of worker
goroutines that read items off a shared `jobs` channel and call a
caller-supplied `process` function on each one, until `jobs` is
closed. This has nothing to do with reacting to an OS signal like
Ctrl-C - there's no signal here at all. It's a purely internal
handshake: once the producer closes `jobs`, how does the pool tell the
caller "every job that was ever submitted has now been fully
processed, it's safe to move on"?

That matters because callers often want to tear something down right
after the pool finishes - closing a downstream file, database
connection, or socket that `process` writes results into. Doing that
teardown too early, while a worker is still mid-call to `process` on
some item it already pulled off `jobs`, silently corrupts or drops
whatever that in-flight call was about to do.

```
jobs producer ──▶ jobs (chan int) ──▶ closed after the last send
                        │
        ┌───────────────┼───────────────┬───────────────┐
        ▼                ▼               ▼               ▼
    worker 1         worker 2        worker 3        worker 4
    range jobs {     range jobs {    range jobs {    range jobs {
      process(i)       process(i)     process(i)      process(i)
    }                }               }               }

TODAY   Start returns done := make(chan struct{}); close(done) - shut
        the instant Start is called, unrelated to the workers above it
        caller: <-done fires INSTANTLY, workers still mid-flight

GOAL    done closes only once EVERY worker has returned from range
        jobs - i.e. its last process() call has actually completed
        caller: <-done fires ⟹ safe to tear down whatever process()
        was writing into
```

`Start` is supposed to return a `done` channel that only closes once
`jobs` has been closed AND every job ever sent to it has been FULLY
processed. Right now it does nothing of the sort: the returned `done`
channel is closed immediately, before any worker has necessarily even
started, let alone processed a single job - so a caller who waits on
it and then tears down whatever `process` was writing into can easily
do so while jobs are still silently being worked on in the background.

Your task is to fix `Start` so the returned `done` channel closes only
once every worker goroutine has fully returned from its `range jobs`
loop - i.e. every worker has finished calling `process` on its
last-received item. `Start` itself must still return immediately -
whatever waits for the workers has to happen concurrently with that
return, not block it. The function signature must stay the same:

```go
func Start(jobs <-chan int, process func(item int)) <-chan struct{}
```

so that it remains a drop-in replacement for the naive version below.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
