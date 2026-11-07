# Graceful Shutdown: Knowing When All Workers Have Finished - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `25-graceful-multistage-shutdown/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting `Start` launches a small, fixed-size worker pool:

```go {12,13}
const numWorkers = 4

func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
	for i := 0; i < numWorkers; i++ {
		go func() {
			for item := range jobs {
				process(item)
			}
		}()
	}

	done := make(chan struct{})
	close(done)
	return done
}
```

`Start` must do these things:

- Return a `done` channel. Close it **only** after `jobs` closes **and** every worker finishes its `range jobs` loop.
- Return immediately. The code that waits for workers must run concurrently.
- Keep the signature unchanged: `func Start(jobs <-chan int, process func(item int)) <-chan struct{}`.

## Why the naive version is wrong

The code creates and immediately closes `done`. This has no connection to the workers. A caller waiting on `done` only knows that `Start` returned.

The caller may then close a resource that `process` uses. That resource could be a file, database connection, or socket. Workers may still be handling jobs. The in-flight work can then fail or be lost.

Verified: the naive `main.go` fails the timing tests:

```
=== RUN   TestStartProcessesEveryJob
    check_test.go:82: done closed with 0/20 jobs actually processed; done must only close once every submitted job has been FULLY processed, not merely received off the jobs channel
--- FAIL: TestStartProcessesEveryJob (0.00s)
=== RUN   TestStartDoesNotDoubleProcessOrDropJobs
--- PASS: TestStartDoesNotDoubleProcessOrDropJobs (0.01s)
=== RUN   TestDoneWaitsForInFlightProcessCall
    check_test.go:208: done closed while a worker was still inside process() - done must only close once every submitted job has FULLY finished, not merely been received off jobs
--- FAIL: TestDoneWaitsForInFlightProcessCall (0.00s)
FAIL
```

`done` closes with **zero** of the 20 jobs processed. It also closes while a worker is blocked inside `process()`. Both cases show that the signal fires too early.

`TestStartDoesNotDoubleProcessOrDropJobs` still passes. It checks collected results instead of trusting `done`. The naive workers do process every job eventually. The processing is correct, but the completion signal is wrong.

`check_test.go` also runs `TestStartProcessesEveryJob`. That test checks the core completion rule.

## Approach 1: `sync.WaitGroup` + a small closer goroutine

```go {19,21,30,31}
package main

import (
	"sync"
)

const numWorkers = 4

// Start launches numWorkers worker goroutines that read from jobs and
// call process on each item until jobs is closed. The returned done
// channel closes only once jobs has been closed AND every worker has
// fully finished calling process on its last-received item, so a
// caller can safely wait on done and then treat the whole pipeline as
// gracefully, completely finished.
func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				process(item)
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	return done
}
```

Design notes:

- **Call `wg.Add(1)` before each `go func(){...}()`.** Use the calling goroutine. This is the safe `sync.WaitGroup` order. Calling `Add` inside the new goroutine can race with `Wait()` and its zero count.
- **Write the call as `go func() {...}()`.** Both forms start the same goroutine.
- **Put `defer wg.Done()` at the top of each worker.** Use `defer` so it always runs. The `range` loop ends after `jobs` closes and drains. The last `process` call finishes before the deferred `Done()` runs.
- **Use a separate goroutine for `wg.Wait()` and `close(done)`.** `Start` must return immediately. The wait has to run beside the caller.
- **Close `done`; do not send a value.** Readers use `<-done`. Closing lets any number of readers observe the event. A closed channel also never blocks later readers.

**Verified:** `gofmt -l` and `go vet ./...` are clean. `go test -race -count=5 ./...` passes repeatedly.

The runs include `TestStartDoesNotDoubleProcessOrDropJobs`, which tests 50 jobs for drops and duplicates. They also include `TestDoneWaitsForInFlightProcessCall`, which confirms that `done` does not fire during `process()`.

## Approach 2: the exercise-16 `Group` pattern instead of a bare `WaitGroup`

This version reuses [exercise 16](../16-errgroup-failfast)'s `errgroup.Group` type. The source folder is `16-errgroup-failfast/`. Its `Go(f func() error)` method starts a task without blocking. Its `Wait() error` method waits for every task. It then returns the first error, using `sync.WaitGroup` and `sync.Once`.

Launch each worker with `g.Go(...)`. The coordinator goroutine then calls `g.Wait()` before it closes `done`.

```go {48,58}
package main

import (
	"sync"
)

const numWorkers = 4

// Group is the exact same hand-rolled errgroup.Group built in exercise
// 16 (16-errgroup-failfast/main.go, Approach 1 there): Go launches a
// task in its own goroutine without blocking, tracked by an internal
// WaitGroup, and Wait blocks until every task launched via Go has
// returned, then returns the first error encountered (via sync.Once).
// This exercise's workers never fail, so every worker closure just
// returns nil - but the type is unmodified from exercise 16.
type Group struct {
	wg       sync.WaitGroup
	once     sync.Once
	firstErr error
}

func (g *Group) Go(f func() error) {
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := f(); err != nil {
			g.once.Do(func() {
				g.firstErr = err
			})
		}
	}()
}

func (g *Group) Wait() error {
	g.wg.Wait()
	return g.firstErr
}

// Start launches numWorkers worker goroutines (via Group.Go) that read
// from jobs and call process on each item until jobs is closed. The
// returned done channel closes only once jobs has been closed AND
// every worker has fully finished calling process on its
// last-received item.
func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
	var g Group

	for i := 0; i < numWorkers; i++ {
		g.Go(func() error {
			for item := range jobs {
				process(item)
			}
			return nil
		})
	}

	done := make(chan struct{})
	go func() {
		_ = g.Wait() // no worker here ever returns an error
		close(done)
	}()

	return done
}
```

Design notes and differences from Approach 1:

- **The structure is the same underneath.** `Group.Go` calls `wg.Add(1)` on the caller's goroutine. It then starts a tracked goroutine that defers `wg.Done()`. `Group.Wait` calls `wg.Wait()`.
- **Each worker must return an `error`.** This exercise cannot fail, so each worker ends with `return nil`. `_ = g.Wait()` throws away the `nil` result. This is the cost of reusing a general-purpose group.
- **Use this version to reuse code.** It does not improve this exercise. If your codebase already has an `errgroup`-style `Group`, reuse it. For one simple wait, use `sync.WaitGroup`.

**Verified:** `gofmt -l` and `go vet ./...` are clean. `go test -race -count=5 ./...` passes repeatedly. The runs include all three tests.

## Key takeaways

- A channel that closes is not always a completion signal. Ask which work must finish before the close.
- Call `sync.WaitGroup.Add(1)` on the caller goroutine before starting the worker. Never call it inside the new goroutine.
- Put `defer wg.Done()` at the start of the worker. It then runs after all worker code, including its last unit of work.
- Use `wg.Wait(); close(done)` in a goroutine. This turns a blocking wait into a signal while `Start` returns immediately.
- Reusing an `errgroup`-style `Group` can reduce duplicate patterns. It adds extra code when the workers cannot fail.
