# Build your own errgroup with first-error capture

> **Spoiler warning.** This file has full solutions for `16-errgroup-failfast/`. Try the exercise first. Come back if you get stuck.

## The problem

The starter `Group` copies the shape of `errgroup` in `golang.org/x/sync/errgroup`. Do not import that package. Use only the standard library.

```go {6}
type Group struct {
	firstErr error
}

func (g *Group) Go(f func() error) {
	if err := f(); err != nil && g.firstErr == nil {
		g.firstErr = err
	}
}

func (g *Group) Wait() error {
	return g.firstErr
}
```

`Group` must:

- `Go(f func() error)` must start `f` in its own goroutine. It must return without blocking.
- `Wait() error` must wait for every task from `Go`. Then it returns the first error.
- The first error must stay safe when many tasks fail at once.
- Track running tasks with a `sync.WaitGroup`, as `main.go` says.
- Skip `context` and cancellation. This is the base `Group`, not `WithContext`.
- Keep `func (g *Group) Go(f func() error)` and `func (g *Group) Wait() error` unchanged.

## Why the naive version is wrong

`Go` calls `f()` directly on the caller's goroutine. It blocks until `f` returns.

- Tasks run one after another. Five tasks of 100ms take 500ms, not about 100ms.
- `Wait` only works by accident. Each call to `Go` already waited for its task.
- `firstErr` has no synchronization. It is safe today only because no tasks run at the same time.
- If `Go` starts a real goroutine, writes to `firstErr` can race. A read from `Wait` can race too.

I ran `check_test.go` against the naive `main.go` in a scratch copy. `TestGroupRunsConcurrently` fails with:

`Wait took 1s (sequential would take 1s); want well under 300ms`.

The other two tests pass by accident. The naive code runs tasks one at a time, so it never has a race.

## Approach 1: `sync.WaitGroup` + `sync.Once`

```go {17,21,22}
package main

import (
	"sync"
)

// Group runs a collection of tasks, started via Go, and collects the
// first error (if any) returned by them once every task has finished.
type Group struct {
	wg       sync.WaitGroup
	once     sync.Once
	firstErr error
}

// Go launches f in its own goroutine and returns immediately.
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

// Wait blocks until every task started via Go has finished, and
// returns the first error encountered, if any.
func (g *Group) Wait() error {
	g.wg.Wait()
	return g.firstErr
}
```

Design notes:

- Call `wg.Add(1)` on the caller before `go func() {...}()` starts. This is the safe order.
- If the new goroutine calls `Add`, `Wait` can see a zero counter too early.
- `sync.Once` makes the first-error rule race-free. Every failure calls `g.once.Do(...)`.
- Only the first caller runs the closure that writes `firstErr`. Later `Do` calls do nothing.
- The first `once.Do` call runs. Every later one does nothing.
- `sync.Once` provides the needed happens-before edge. The write needs no separate mutex.
- `Wait` needs no lock to read `firstErr`. `wg.Wait()` returns only after every task calls `Done()`.
- A task writes `firstErr` before `defer g.wg.Done()` runs. `Done` then signals the group.
- The `WaitGroup` synchronization makes every earlier write visible to `Wait`.
- The tests use `Group` as a zero value, `var g Group`. They have no `NewGroup()` call.
- `sync.WaitGroup` and `sync.Once` work in their zero form. No constructor is needed.
- This fit is better than a channel, which would need explicit setup.

I tested the solution in a scratch copy. The naive `main.go` fails `TestGroupRunsConcurrently`. The solution passes these commands:

- `go vet ./...`
- `go test -race -count=5 ./...`

The passing checks include `TestGroupFirstErrorRaceSafe`. That test starts 50 failing tasks at once with no sleep. It looks for a race in the first-error capture.

## Approach 2: `sync.WaitGroup` + buffered `chan error` (non-blocking send)

This version uses a different primitive to capture the first error. It does not use `sync.Once` to guard a plain field.

It uses a `chan error` with capacity 1. The send uses `select` and `default`.

Only the first send fills the one buffer slot. Every later send reaches `default` and is dropped.

```go {33,34,35,44}
package main

import (
	"sync"
)

// Group runs a collection of tasks, started via Go, and collects the
// first error (if any) returned by them once every task has finished.
type Group struct {
	wg       sync.WaitGroup
	errCh    chan error
	initOnce sync.Once
}

// init lazily creates errCh. It's called from both Go and Wait - not
// just Go - because Group has no constructor (callers use the zero
// value, var g Group), so every method that touches errCh must go
// through the same sync.Once to avoid an unsynchronized read/write
// race on the field itself the very first time either method runs.
func (g *Group) init() {
	g.initOnce.Do(func() {
		g.errCh = make(chan error, 1)
	})
}

// Go launches f in its own goroutine and returns immediately.
func (g *Group) Go(f func() error) {
	g.init()
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := f(); err != nil {
			select {
			case g.errCh <- err: // first failing task claims the one buffer slot
			default: // slot already taken - drop this error, keep the first
			}
		}
	}()
}

// Wait blocks until every task started via Go has finished, and
// returns the first error encountered, if any.
func (g *Group) Wait() error {
	g.init()
	g.wg.Wait()
	select {
	case err := <-g.errCh:
		return err
	default:
		return nil
	}
}
```

Design notes and tradeoffs:

- `errCh` needs lazy setup. Every method that touches it must call `init()`, including `Wait`.
- `Group` has no constructor, and the tests use `var g Group`. The channel does not exist until `init()` creates it.
- Calling `init()` only from `Go` is not enough. `Wait()` also reads the `errCh` field.
- If `Wait()` and the first `Go` call run together, that field access can race.
- Routing both methods through the same `sync.Once` closes that gap.
- The non-blocking `select` send works like `sync.Once.Do`. The one buffer slot can be claimed only once.
- One error gets through. Later errors reach `default` and are dropped.
- `Wait()` here is single-use, unlike Approach 1. It drains the channel with `<-g.errCh`.
- I added a second `g.Wait()` call. It returns `nil` after the first call consumed the error.
- Approach 1 reads `firstErr` without consuming it. Repeated `Wait()` calls return the same error.
- I tested this difference in both scratch versions. Approach 1 returned the same error twice.
- Approach 2 returned the error once, then `<nil>`. The given tests call `Wait()` only once.
- Both versions pass every current test.
- Use Approach 1 if `Wait()` may run more than once.
- Use Approach 2 only if single-use `Wait()` is acceptable.

I tested this version in a scratch copy. An earlier draft called `init()` only from `Go`. That left the `Wait()` field read unprotected.

The exercise tests can miss this race. Every test calls `Go` before `Wait`, and it calls them one at a time. Calling `init()` at the start of `Wait()` fixes the gap.

After the fix, `go vet ./...` is clean. `go test -race -count=5 ./...` also passes. This includes `TestGroupFirstErrorRaceSafe`.

## Key takeaways

- Call `sync.WaitGroup.Add(1)` on the caller before `go func(){...}()`. Never call it inside the new goroutine.
- If `Add` runs late, `Wait()` can pass a counter that is still zero.
- `sync.Once` makes only the first failure count. It needs no separate mutex.
- `sync.Once` gives its guarded closure the needed happens-before edge.
- A buffered `chan error` of capacity 1 can also capture the first error.
- Use a non-blocking `select` and `default` send. The first value fills the one slot.
- Reading with `<-ch` consumes the value. That makes `Wait` single-use unless you add more state.
- A zero-value type has no constructor. Every method that touches a lazy field must use the same `sync.Once`.
- Missing that guard is a real data race. Happy-path tests can miss it, even with `-race`.
- Sequential code does not trigger the race detector. A synchronous `Go` can look safe by accident.
- That stub still fails the concurrency and throughput test.
