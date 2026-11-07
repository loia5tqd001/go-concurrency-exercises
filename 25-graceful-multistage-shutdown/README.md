# Graceful Multi-Stage Shutdown: Knowing When a Worker Pool Has REALLY Finished

`Start` launches a small fixed-size pool of worker goroutines. Each
worker reads items from a shared `jobs` channel. It calls the caller's
`process` function on each item. This continues until `jobs` is closed.

This does not react to an OS signal such as Ctrl-C. There is no signal
in this exercise. The question is internal: after `jobs` closes, how
does the pool report that all work is done?

The answer matters. A caller may close a file, database connection, or
socket after the pool finishes. If the caller closes it too early,
`process` may still be using it. Results can then be lost or corrupted.

```
jobs producer ──▶ jobs (chan int) ──▶ closed after the last send
                        │
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
    worker 1         worker 2        worker 3        worker 4
    range jobs {     range jobs {    range jobs {    range jobs {
      process(i)       process(i)      process(i)      process(i)
    }                }               }               }

TODAY   Start returns done := make(chan struct{}); close(done) - shut
        the instant Start is called, unrelated to the workers above it
        caller: <-done fires INSTANTLY, workers still mid-flight

GOAL    done closes only once EVERY worker has returned from range
        jobs - i.e. its last process() call has actually completed
        caller: <-done fires ⇒ safe to tear down whatever process()
        was writing into
```

`Start` must return a `done` channel. That channel must close only after
`jobs` is closed and every job is fully processed. Today, `done` closes
at once. Workers may not have started, and jobs may still be running.

Fix `Start` so `done` closes only after every worker leaves its
`range jobs` loop. That means each worker has finished its last
`process` call. `Start` must still return at once. Waiting for the
workers must happen concurrently. The function signature must stay the
same:

```go
func Start(jobs <-chan int, process func(item int)) <-chan struct{}
```

It must remain a drop-in replacement for the current version.

## Test your solution

The tests must pass:

```
go test
go test --race
```
