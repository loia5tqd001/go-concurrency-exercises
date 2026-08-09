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

## Approach 1 (recommended default): `sync.OnceValue`, keyed by a map

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

Design notes:

- **`sync.OnceValue` (Go 1.21+) is the standard-library answer to "compute once, share safely, cache forever."** It wraps a `func() int` so that no matter how many goroutines call the returned function, and no matter when, `ComputeExpensive` runs exactly once and every caller gets the same cached value — no hand-rolled `done` channel or result field needed.
- **The mutex only ever guards the map lookup**, not the computation itself. Whoever finds `key` missing wraps a fresh `sync.OnceValue` closure and stores it, then immediately unlocks — everyone else, first callers and latecomers alike, just reads the same `compute` function back out of the map and calls it. Calling `compute()` is what actually blocks until the result is ready (or returns instantly if it already ran); the mutex is never held across that call.
- **Every call to `Future` gets its own per-call channel and its own tiny forwarder goroutine** (`ch <- compute(); close(ch)`). This is what makes the function signature work: any number of goroutines can call the same shared `compute` function at once, but each *caller* of `Future` still gets back a private `<-chan int` they own exclusively.
- **This is a few lines shorter than hand-rolling the "compute once" mechanism**, and pushes the tricky part of the problem onto a primitive designed for exactly this job — usually the right call once you know it exists.

**Verified**: copied this exercise into a throwaway scratch directory, confirmed the naive `main.go` fails 3 of the 4 tests above, then dropped in this solution. `go vet ./...` is clean, and `go test -race -count=1 ./...` passes repeatably across 5 separate runs — including `TestFutureDedupesConcurrentCallers`, which launches 20 concurrent `Future("k3")` callers and asserts `ComputeExpensive` ran exactly once.

## Approach 2: keyed `done` channel, closed once the result is stored

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

This is the same idea as Approach 1, but built by hand instead of delegating to `sync.OnceValue`: **`entry.done` is the broadcast primitive**, exactly as in the earlier per-instance version of this exercise — the compute goroutine writes `e.result` *before* closing `e.done`, and `close()` establishes a happens-before edge with every receive that observes it, so any goroutine unblocked by `<-e.done` is guaranteed to see the write, no separate lock needed around `result` itself. The difference from the old design is scope: the entry, and its `done` channel, now live once *per key* in a shared map, not once per `Future` value handed to a single caller. This satisfies "exactly once, forever" the same way Approach 1 does — the entry is never removed from `cache`, so a call for `key` made long after the result is ready just finds `e.done` already closed and returns near-instantly with the cached `e.result`.

Worth doing by hand at least once even though Approach 1 is the better default: `close()` as a happens-before broadcast is a building block you'll reach for in places `sync.OnceValue` doesn't cover (e.g. broadcasting a value alongside a `context`-style cancellation signal). But it comes with a real downside Approach 1 doesn't have — see the caveat below.

**Verified**: same throwaway scratch directory, swapped in this version, `go vet ./...` clean, `go test -race -count=1 ./...` passes repeatably across 3 runs, including `TestFutureDedupesConcurrentCallers`.

## A caveat worth knowing about, not fixing: `-count > 1`

Both approaches above pass the full suite cleanly at `-count=1` (all the README asks for: `go test`, `go test --race`). Push past that with `go test -race -count=2` and both approaches fail — for related but distinct reasons, and Approach 2's failure mode is materially worse.

**Approach 1 (`sync.OnceValue`)**: `cache` is a package-level map that lives for the process's lifetime and is never reset. `check_test.go`'s tests reuse fixed literal keys (`"k3"`, `"k4"`) and only reset the call counter between runs (`ResetCallCount`), not the cache itself. On a second `-count=2` pass, `Future("k3")` finds an already-populated `compute` function from the first pass and returns the cached result — correct behavior per the exercise's own "cache forever" requirement — but `ComputeExpensive` correctly doesn't run again, so the freshly-reset call counter reports 0 instead of the expected 1:

```
--- FAIL: TestFutureDedupesConcurrentCallers (ComputeExpensive ran 0 times across 20 concurrent callers, want exactly 1)
--- FAIL: TestFutureCachesAfterCompletion (ComputeExpensive ran 0 times across two sequential calls, want exactly 1)
```

This is a test-assertion mismatch, not a `Future` bug — a real caller would be delighted that repeated calls for a warm key skip recomputation.

**Approach 2 (`entry`/`done` channel)** hits the same stale-cache issue on the count-based assertions, but its `TestFutureReturnsImmediately` and `TestFutureCachesAfterCompletion` runs (both wrapped in `synctest.Test`) fail *harder* — a fatal panic, not a test assertion:

```
fatal error: receive on synctest channel from outside bubble
```

The reason: `entry.done` is a channel, and it's cached forever, same as the result. A channel created inside one `synctest.Test` bubble stays permanently associated with that bubble — `testing/synctest`'s isolation rule says operating on a bubbled channel from outside its bubble panics, even after the channel is closed. `-count=2` reruns `TestFutureReturnsImmediately` a second time, in a *new* bubble, with the *same* key (`"k1"`) — so it pulls the cached `entry` (and its first-bubble `done` channel) back out of the map and receives on it from the new bubble. Approach 1 never hits this because `compute` is a plain closure with no channel inside it; nothing bubble-tied ever gets cached.

Neither approach is designed to survive `-count>1` with reused keys, and the exercise doesn't ask for that — but it's one more reason Approach 1 is the safer default: the same "cache forever" requirement degrades gracefully (a slightly-confusing test assertion) instead of catastrophically (a fatal panic) when that assumption gets stressed. If you ever add tests here, the fix on either approach is the same one `check_test.go` already follows: never reuse a key across two separate test runs that might share process state, and never reuse a key across two separate `synctest.Test` calls.

**Verified**: swapped each approach into `main.go` in turn and ran `go test -race -count=2 ./...`. Approach 1 fails the two call-count assertions above and nothing else. Approach 2 panics on its first `synctest`-wrapped test before ever reaching the call-count assertions.

## Key takeaways

- **A plain `<-chan int` return, not a `Future` struct with `Get()`, is the idiomatic Go shape** for "an async result you'll receive later" — Go's channel already *is* the future/promise primitive other languages bolt on as a separate type.
- **Scope the memoization to the key, not to a single call.** The old per-instance design (one `Future` value, many `Get()` callers on it) got "exactly once" for free just by construction — there was only ever one computation because there was only ever one instance. Once the requirement becomes "dedupe by key across independently-made calls," that guarantee has to move into a shared, mutex-guarded structure (a map), because there's no longer a single object whose constructor runs exactly once to hang the guarantee on.
- **`sync.OnceValue` is the standard-library answer to "compute once, share safely, cache forever."** If you find yourself hand-rolling a `done` channel plus a result field just to get once-only, safely-shared computation, check whether `sync.Once` / `sync.OnceValue` / `sync.OnceFunc` already says what you mean — it also sidesteps caching a channel forever, which is what makes Approach 2 fragile under repeated test runs (see the caveat above).
- **Every caller still gets a private channel.** Sharing the underlying computation (via a keyed `sync.OnceValue`, or a keyed `entry`/`done` channel) doesn't mean sharing the delivery mechanism — each call to `Future` spins up its own small forwarder goroutine and its own channel, so no two callers ever race to receive from the same channel.
- **If you need this for real, don't hand-roll the keyed cache either** — `golang.org/x/sync/singleflight` is the production-grade version of exactly this pattern (dedupe concurrent identical work by key), with support for not caching forever and for propagating errors, both of which this exercise deliberately leaves out to keep the core lesson — async result + keyed memoization — in focus.
- **Synctest bubbles are per-call, and channels are bubble-scoped.** A package-level cache that outlives any single test is fine, but a channel created inside one `synctest.Test` bubble can never be touched by a goroutine outside that bubble, including from a *different* bubble later in the same process. Give synctest-wrapped tests unique keys/state rather than sharing memoized channel-bearing structures across them — and prefer a design (like Approach 1) that never caches a channel in the first place.
