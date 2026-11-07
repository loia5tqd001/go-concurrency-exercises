# Your Own errgroup: Concurrent Tasks with First-Error Capture

`Group` copies `Group` from `golang.org/x/sync/errgroup`. Build it
with the standard library only. Do not import that package. `Go`
registers a task. `Wait` waits for every task and returns the first
error, if any.

Today, `Go` runs the function immediately on the caller. It waits for
the function to return. Tasks therefore run one after another. The
shared first-error field has no protection either. Real code may call
`Go` from many goroutines before `Wait`. Start all tasks before
calling `Wait`. A `WaitGroup` must not race a new `Add` from zero.

```
TODAY (1 goroutine)
  caller  Go(t1)--100ms-->Go(t2)--100ms--> ... -->Go(t10)--100ms-->
          Wait() returns firstErr at once; 10 x 100ms = 1s

GOAL (11 goroutines: 1 caller + 10 workers)
                    +--> t1  100ms --+
                    |                |
  caller  Go(t1..10)+--> t2  100ms --+--> Wait() joins all 10: ~100ms
                    |      ...       |    sync.Once keeps the first error
                    +--> t10 100ms --+
```

Your task is to fix `Group`:

- `Go(f func() error)` starts `f` in its own goroutine and returns
  without waiting. Track the goroutine with an internal
  `sync.WaitGroup`.
- `Wait() error` waits for every goroutine started by `Go`. It returns
  the first error. Capture that error safely if many tasks fail at
  once. Use `sync.Once` or a mutex. Do not create a data race.

Do not add `WithContext`, `context`, or cancellation support. Keep
only `Go` and `Wait`, like the base errgroup `Group`. The signatures
must stay the same:

```go
func (g *Group) Go(f func() error)
func (g *Group) Wait() error
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
