# Future and promise: async work done once

> **Spoiler warning.** This file has full solutions for `17-future-promise/`. Try the exercise first. Come back if you get stuck.

## The problem

The starter is a `Future` function:

```go {3}
func Future(key string) <-chan int {
	ch := make(chan int, 1)
	ch <- ComputeExpensive(key)
	close(ch)

	return ch
}
```

`Future` must:

- Start `ComputeExpensive(key)` in its own goroutine.
- `mockcompute.go` sleeps for `ComputeLatency`, which is 150ms. Then it returns a result based on the key.
- Return a channel almost at once. Do not wait for the computation.
- The channel must deliver one value, the result for `key`. A receive must wait until the value is ready.
- Deduplicate by key. If `Future(key)` is called again, it must not run `ComputeExpensive` again.
- This applies while work is running and after it is cached. It applies to any number of callers.
- Keep `func Future(key string) <-chan int` unchanged.

Earlier drafts used `NewFuture(key) *Future` and `(*Future).Get() int`. That is a Java/JS-style future object. It is not the usual Go answer.

See the [README](../17-future-promise/README.md#why-a-channel-not-a-future-struct-with-get). It explains why this version returns a plain `<-chan int`. It also explains why the code uses `sync.OnceValue` instead of a hand-written `sync.Once` guard.

## Why the naive version is wrong

`Future` calls `ComputeExpensive(key)` directly on the caller's goroutine. It blocks before it returns the channel. It also runs the computation on every call and remembers nothing.

- Every `Future` call blocks for 150ms. This defeats the purpose of a future.
- Two calls for one key each take 150ms. Each call also increments the counter. Nothing is shared.

I ran the exercise tests against the naive `main.go` in a scratch copy.
Four of five tests fail:

```
--- FAIL: TestFutureReturnsImmediately (Future took 150ms, want near-instant)
--- FAIL: TestFutureDedupesConcurrentCallers (ComputeExpensive ran 20 times across 20 concurrent callers, want 1)
--- FAIL: TestFutureCachesAfterCompletion (second call took 150ms and ran ComputeExpensive again, want cached/instant)
```

`TestFutureReturnsCorrectResult` passes. The naive version returns the right value. It is just not async and not shared.

`TestFutureRunsDifferentKeysConcurrently` also fails. The two keys run
one after the other.

## Approach 1 (recommended default): `sync.OnceValue`, keyed by a map

```go {19,21,29}
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

- `sync.OnceValue` works in Go 1.21 and later. It is the standard way to compute once, share safely, and cache forever.
- It wraps a `func() int`. `ComputeExpensive` then runs once for every caller, at any time or from any goroutine.
- Every caller gets the same cached value. You do not need a hand-written `done` channel or result field.
- The mutex only protects the map lookup. It does not protect the computation.
- The first caller adds a new `sync.OnceValue` function and unlocks. Later callers read the same function and call it.
- Calling `compute()` blocks until the result is ready. It returns at once after the value is cached.
- The mutex is never held during that call.
- Each `Future` call gets a private channel and a small forwarder goroutine. The code is `ch <- compute(); close(ch)`.
- Many goroutines can share `compute`. Each caller still owns a separate `<-chan int`.
- This version is shorter than a hand-written once-only mechanism. It uses a standard tool made for this job.

I tested this version in a scratch copy. The naive `main.go` fails the
four tests above. The solution passes:

- `go vet ./...`
- `go test -race -count=1 ./...`

It passed five separate runs. This includes `TestFutureDedupesConcurrentCallers`. That test starts 20 `Future("k3")` callers at once and checks that `ComputeExpensive` runs once.

## Approach 2: keyed `done` channel, closed once the result is stored

```go {27,31,32,40}
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

This uses the same idea as Approach 1, but builds it by hand. `entry.done` broadcasts the result.

The compute goroutine writes `e.result` before it closes `e.done`. Calling `close()` creates a happens-before edge for every receive that sees it. A goroutine that wakes from `<-e.done` then sees the result. `result` needs no separate lock.

The entry and its `done` channel live once per key in a shared map. The old design kept them per `Future` value.

This still gives "exactly once, forever." The code never removes the entry from `cache`. A late call finds `e.done` closed and returns the cached `e.result` at once.

It is worth building by hand once. Closing a channel as a broadcast is useful where `sync.OnceValue` does not fit. One example is sending a value with a `context`-style cancellation signal.

This version has a real downside that Approach 1 avoids. See the caveat below.

I tested this version in the same scratch copy. `go vet ./...` is clean. `go test -race -count=1 ./...` passed three runs. This includes `TestFutureDedupesConcurrentCallers`.

## Repeated test runs with unique keys

Both approaches pass the full suite at `-count=1`. This covers `go test` and `go test --race`, as the README asks.

The current tests use `uniqueTestKey`. They isolate keys across
`-count > 1` runs.

`ResetCallCount` resets the call counter, not the cache. The cache stays
alive for the whole process.

Both designs pass `-count=2` with the current tests. Each run uses new
keys, such as `"k3"` and `"k4"`.

The fence below shows an older fixed-key test setup. It does not describe
the current tests:

```
--- FAIL: TestFutureDedupesConcurrentCallers (ComputeExpensive ran 0 times across 20 concurrent callers, want exactly 1)
--- FAIL: TestFutureCachesAfterCompletion (ComputeExpensive ran 0 times across two sequential calls, want exactly 1)
```

That output is historical. It is not current behavior.

Approach 2 still caches an `entry`. Reusing its `entry.done` across two
`synctest.Test` bubbles can panic. The old
`TestFutureReturnsImmediately` and `TestFutureCachesAfterCompletion`
runs exposed this:

```
fatal error: receive on synctest channel from outside bubble
```

The cache keeps `entry.done` forever, just like the result. A channel
from one `synctest.Test` bubble stays tied to that bubble.

`testing/synctest` panics if code outside the bubble uses that channel. This is true even after the channel closes.

Reusing a key, such as `"k1"`, in a second bubble can trigger this.
The current tests avoid it with unique keys.

Any `-count>1` run can hit this if it reuses a key. The old command
was `go test -race -count=2 ./...` or `go test -race -count=2`.

Approach 1 avoids this. Its `compute` is a plain closure with no channel inside it.

If you add tests, follow `check_test.go`. Use a new key for each run.
Do not reuse a key across two `synctest.Test` calls.

## Key takeaways

- Return a plain `<-chan int`, not a `Future` struct with `Get()`. This is the usual Go shape.
- A Go channel already acts as a future or promise. Other languages add a separate type for this.
- Scope memoization to the key, not one call. The old design had one `Future` and many `Get()` callers.
- That old design got "exactly once" from having one instance. A keyed design needs a shared, mutex-guarded map.
- `sync.OnceValue` computes once, shares safely, and caches forever. Check it before writing a `done` channel and result field.
- `sync.Once` and `sync.OnceFunc` are related options.
- Approach 1 does not cache a channel. Approach 2 needs unique keys for
  each test bubble.
- Every caller still gets a private channel. The callers share the computation, not the delivery channel.
- Each `Future` call starts its own forwarder goroutine and channel. Two callers never receive from the same channel.
- For production code, do not hand-write the keyed cache. `golang.org/x/sync/singleflight` handles identical work by key.
- `singleflight` does not cache forever, and it can pass errors. This exercise leaves those features out to focus on the core lesson.
- `synctest` bubbles belong to one call. A channel from one bubble
  cannot be used outside it.
- Use unique keys as the current tests do. Prefer Approach 1 when
  repeated test runs must stay isolated.
