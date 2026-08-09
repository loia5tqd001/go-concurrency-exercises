# Future/Promise Pattern: Async, Memoized Computation — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `17-future-promise/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

The starting point is a `Future` function:

```go
func Future(key string) <-chan int {
	ch := make(chan int, 1)
	ch <- ComputeExpensive(key)
	close(ch)

	return ch
}
```

`Future` must:

- **Kick off `ComputeExpensive(key)` in its own goroutine** (see `mockcompute.go` — it sleeps for `ComputeLatency` = 150ms before returning a deterministic, key-derived result) and **return a channel near-instantly**, without waiting for the computation.
- Have the returned channel **deliver exactly one value** — the result for `key` — and **block until it's ready** when received from.
- **Dedupe by key**: calling `Future(key)` again for a key that's already in flight, or already cached, must never trigger another call to `ComputeExpensive` for that key — no matter how many goroutines call it, or how many times.
- Keep the signature unchanged: `func Future(key string) <-chan int`.

Earlier drafts of this exercise had you build this as a `NewFuture(key) *Future` / `(*Future).Get() int` pair — a Java/JS-shaped "Future object." That's not the idiomatic Go answer. See the [README](../17-future-promise/README.md#why-a-channel-not-a-future-struct-with-get) for why this version returns a plain `<-chan int` instead, and reaches for `sync.OnceValue` rather than a hand-rolled `sync.Once` guard.

## Why the naive version is wrong

`Future` calls `ComputeExpensive(key)` **synchronously**, right on the calling goroutine, before the channel is even returned. And it does that **on every call**, with no memory of previous calls at all. That means:

- Every call to `Future` blocks the caller for the full 150ms of `ComputeExpensive` up front — defeating the entire point of a future.
- Two calls for the same key — concurrent or sequential — each pay the full 150ms and each increment the call counter, since nothing is shared between them.

Verified: running the current `check_test.go` against this naive `main.go` in a throwaway scratch copy fails three of the four tests:

```
--- FAIL: TestFutureReturnsImmediately (Future took 150ms, want near-instant)
--- FAIL: TestFutureDedupesConcurrentCallers (ComputeExpensive ran 20 times across 20 concurrent callers, want 1)
--- FAIL: TestFutureCachesAfterCompletion (second call took 150ms and ran ComputeExpensive again, want cached/instant)
```

`TestFutureReturnsCorrectResult` passes — the naive version's *value* is correct, it's just never async and never shared.

## Approach 1: keyed `done` channel, closed once the result is stored

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type entry struct {
	done   chan struct{}
	result int
}

var (
	mu    sync.Mutex
	cache = map[string]*entry{}
)

// Future kicks off ComputeExpensive(key) in the background - or, if a
// call for the same key is already in flight or already cached,
// shares that single computation instead - and returns a channel that
// will receive the one result once it's ready.
func Future(key string) <-chan int {
	mu.Lock()
	e, ok := cache[key]
	if !ok {
		e = &entry{done: make(chan struct{})}
		cache[key] = e

		go func() {
			e.result = ComputeExpensive(key)
			close(e.done)
		}()
	}
	mu.Unlock()

	ch := make(chan int, 1)

	go func() {
		<-e.done
		ch <- e.result
		close(ch)
	}()

	return ch
}

func main() {
	start := time.Now()
	ch := Future("report-42")
	constructTime := time.Since(start)

	fmt.Printf("Future returned after %s\n", constructTime)

	result := <-ch
	fmt.Printf("Result: %d (total elapsed %s)\n", result, time.Since(start))
}
```

Design notes:

- **The mutex only ever guards the map lookup**, not the computation itself. Whoever finds `key` missing creates the `entry` and launches the one background goroutine that will ever call `ComputeExpensive` for that key, then immediately unlocks — everyone else, first callers and latecomers alike, just reads the same `*entry` back out of the map.
- **`entry.done` is the broadcast primitive**, exactly as in the earlier per-instance version of this exercise: the compute goroutine writes `e.result` *before* closing `e.done`, and `close()` establishes a happens-before edge with every receive that observes it — so any goroutine unblocked by `<-e.done` is guaranteed to see the write, no separate lock needed around `result` itself. The difference from the old design is scope: the entry, and its `done` channel, now live once *per key* in a shared map, not once per `Future` value handed to a single caller.
- **Every call to `Future`, cached or not, gets its own per-call channel and its own tiny forwarder goroutine** (`<-e.done; ch <- e.result; close(ch)`). This is what makes the function signature work: the shared `entry` can have many goroutines blocked on its `done` channel at once, but each *caller* of `Future` still gets back a private `<-chan int` they own exclusively — nobody has to share a receive with a stranger's goroutine.
- **This satisfies "exactly once, forever" for free**: there's only ever one compute goroutine launched per key (guarded by the `ok` check under `mu`), and the entry is never removed from `cache`, so a call for `key` made long after the result is ready just finds `e.done` already closed and returns near-instantly with the cached `e.result` — see `TestFutureCachesAfterCompletion`.

**Verified**: copied this exercise into a throwaway scratch directory, confirmed the naive `main.go` fails 3 of the 4 tests above, then dropped in this solution. `go vet ./...` is clean, and `go test -race -count=1 ./...` passes repeatably across 5 separate runs — including `TestFutureDedupesConcurrentCallers`, which launches 20 concurrent `Future("k3")` callers and asserts `ComputeExpensive` ran exactly once.

**A caveat worth knowing about, not fixing**: this package-level `cache` persists for the life of the process. If the *same key* were reused across two separate `synctest.Test`-wrapped tests within one `go test -count=N` run (N > 1) or one process, the second synctest bubble would try to receive on `e.done` — a channel created inside the *first* bubble — and `testing/synctest` fails hard with `"receive on synctest channel from outside bubble"`. This isn't a bug in the solution so much as a sharp edge of combining an intentionally-permanent memoization cache with `synctest`'s per-bubble channel isolation; the test suite avoids it by giving every synctest-wrapped test its own unique key. Worth remembering if you ever add tests here: never reuse a key across two separate `synctest.Test` calls.

## Approach 2: `sync.OnceValue`, keyed by a map

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

var (
	mu    sync.Mutex
	cache = map[string]func() int{}
)

// Future kicks off ComputeExpensive(key) in the background - or
// shares the in-flight/cached computation for that key - and returns
// a channel that will receive the one result once it's ready.
func Future(key string) <-chan int {
	mu.Lock()
	compute, ok := cache[key]
	if !ok {
		compute = sync.OnceValue(func() int { return ComputeExpensive(key) })
		cache[key] = compute
	}
	mu.Unlock()

	ch := make(chan int, 1)

	go func() {
		ch <- compute()
		close(ch)
	}()

	return ch
}

func main() {
	start := time.Now()
	ch := Future("report-42")
	constructTime := time.Since(start)

	fmt.Printf("Future returned after %s\n", constructTime)

	result := <-ch
	fmt.Printf("Result: %d (total elapsed %s)\n", result, time.Since(start))
}
```

This is the same idea as Approach 1, but delegates the "compute once, let any number of concurrent callers block on and share the result, cache forever" part entirely to the standard library: `sync.OnceValue` (Go 1.21+) wraps a `func() int` so that no matter how many goroutines call the returned function, and no matter when, `ComputeExpensive` runs exactly once and every caller gets the same cached value. The mutex-guarded map's only job is picking (or creating) the right memoized `compute` function for `key`; the per-call goroutine and channel are the same thin async-delivery wrapper as before, just calling `compute()` instead of waiting on `e.done`.

This is a few lines shorter and pushes the tricky part of the problem onto a primitive designed for exactly this job — usually the right call once you know it exists. Approach 1 is worth doing by hand at least once, though, since `close()` as a happens-before broadcast is a building block you'll reach for in places `sync.OnceValue` doesn't cover (e.g. broadcasting a value alongside a `context`-style cancellation signal).

**Verified**: same throwaway scratch directory, swapped in this version, `go vet ./...` clean, `go test -race -count=1 ./...` green across 3 repeated runs.

## Key takeaways

- **A plain `<-chan int` return, not a `Future` struct with `Get()`, is the idiomatic Go shape** for "an async result you'll receive later" — Go's channel already *is* the future/promise primitive other languages bolt on as a separate type.
- **Scope the memoization to the key, not to a single call.** The old per-instance design (one `Future` value, many `Get()` callers on it) got "exactly once" for free just by construction — there was only ever one computation because there was only ever one instance. Once the requirement becomes "dedupe by key across independently-made calls," that guarantee has to move into a shared, mutex-guarded structure (a map), because there's no longer a single object whose constructor runs exactly once to hang the guarantee on.
- **Every caller still gets a private channel.** Sharing the underlying computation (via a keyed `entry`/`done` channel, or a keyed `sync.OnceValue`) doesn't mean sharing the delivery mechanism — each call to `Future` spins up its own small forwarder goroutine and its own channel, so no two callers ever race to receive from the same channel.
- **`sync.OnceValue` is the standard-library answer to "compute once, share safely, cache forever."** If you find yourself hand-rolling a `done` channel plus a result field just to get once-only, safely-shared computation, check whether `sync.Once` / `sync.OnceValue` / `sync.OnceFunc` already says what you mean.
- **If you need this for real, don't hand-roll the keyed cache either** — `golang.org/x/sync/singleflight` is the production-grade version of exactly this pattern (dedupe concurrent identical work by key), with support for not caching forever and for propagating errors, both of which this exercise deliberately leaves out to keep the core lesson — async result + keyed memoization — in focus.
- **Synctest bubbles are per-call, and channels are bubble-scoped.** A package-level cache that outlives any single test is fine, but a channel created inside one `synctest.Test` bubble can never be touched by a goroutine outside that bubble, including from a *different* bubble later in the same process. Give synctest-wrapped tests unique keys/state rather than sharing memoized channel-bearing structures across them.
