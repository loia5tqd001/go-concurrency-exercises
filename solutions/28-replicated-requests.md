# Replicated Requests: Racing Calls to Reduce Tail Latency - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `28-replicated-requests/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting `FetchFastest` sends one request to several `Replica` handlers at once. It should return the first answer. This prevents one slow replica from delaying the caller:

```go {17}
type Replica func(done <-chan struct{}) (string, error)

func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {
	if len(replicas) == 0 {
		return "", errors.New("fetchfastest: no replicas provided")
	}

	results := make(chan replicaResult, len(replicas))

	for _, replica := range replicas {
		go func(r Replica) {
			// BUG: every replica is handed a nil done, so none of
			// them can ever learn that FetchFastest already picked a
			// winner (or that the caller cancelled). A losing replica
			// just keeps running for its full artificial latency
			// instead of stopping as soon as it lost the race.
			value, err := r(nil)
			results <- replicaResult{value: value, err: err}
		}(replica)
	}

	select {
	case res := <-results:
		return res.value, res.err
	case <-done:
		return "", errors.New("fetchfastest: cancelled before any replica responded")
	}
}
```

The code already starts one goroutine per replica. It returns the first value or error on `results`. It passes tests that only check the returned value.

Keep the `Replica` type and the `FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error)` signature unchanged.

## Why the naive version is wrong

Each replica goroutine calls `r(nil)`. It gets a `nil` done channel, not the caller's `done`. A `nil` channel blocks forever on send or receive. `case <-done` can therefore never fire inside `Replica`.

After `FetchFastest` returns a winner, each loser keeps working. No receiver remains for its result. This is a goroutine leak on every call. It clears only when the mock's timer fires.

Verified: the naive `main.go` fails two tests. Every replica runs to completion because it received a `nil` done channel. This happens whether a replica wins or the caller's `done` closes first:

```
=== RUN   TestFetchFastestReturnsFastestValue
    check_test.go:93: replica "slow1" never observed its done channel being closed - it is going to keep running all the way to its full artificial latency instead of stopping as soon as it lost the race
    check_test.go:93: replica "slow2" never observed its done channel being closed - it is going to keep running all the way to its full artificial latency instead of stopping as soon as it lost the race
    check_test.go:93: replica "slow3" never observed its done channel being closed - it is going to keep running all the way to its full artificial latency instead of stopping as soon as it lost the race
--- FAIL: TestFetchFastestReturnsFastestValue (0.00s)
=== RUN   TestFetchFastestReturnsWinnerError
--- PASS: TestFetchFastestReturnsWinnerError (0.00s)
=== RUN   TestFetchFastestClosedDoneCancelsEarly
    check_test.go:177: replica "a" never observed its done channel being closed after the caller's done fired with no winner - it is going to keep running all the way to its full artificial latency instead of stopping as soon as the caller cancelled
    check_test.go:177: replica "b" never observed its done channel being closed after the caller's done fired with no winner - it is going to keep running all the way to its full artificial latency instead of stopping as soon as the caller cancelled
--- FAIL: TestFetchFastestClosedDoneCancelsEarly (0.00s)
=== RUN   TestFetchFastestNoReplicas
--- PASS: TestFetchFastestNoReplicas (0.00s)
=== RUN   TestFetchFastestConcurrentSafety
--- PASS: TestFetchFastestConcurrentSafety (0.00s)
FAIL
```

`TestFetchFastestNoReplicas` and `TestFetchFastestConcurrentSafety` use `fetchFastestWithTimeout` from `check_test.go`. This helper limits the call. A broken fix fails in seconds instead of waiting for Go's 10-minute timeout. It does not change correct behavior.

`TestFetchFastestReturnsWinnerError`, `TestFetchFastestNoReplicas`, and `TestFetchFastestConcurrentSafety` still pass. They do not check losing replicas.

`TestFetchFastestReturnsFastestValue` and `TestFetchFastestClosedDoneCancelsEarly` check the losers with `ObservedCancellation()` and `RanToCompletion()`. A cancelled loser makes `ObservedCancellation()` return `true`. One test covers a replica win. The other covers the caller's `done` closing first. Both fail on the naive code.

Both tests run under `synctest.Test` from `testing/synctest`.

The naive answer is correct. Its cleanup is not.

## Approach 1: a single shared `stop` channel, closed via `defer`

```go {36,37,39,43}
package main

import (
	"errors"
	"fmt"
	"time"
)

// Replica represents one redundant handler that can serve a request.
// A well-behaved Replica must return promptly once done is closed,
// instead of continuing to run to completion regardless.
type Replica func(done <-chan struct{}) (string, error)

// replicaResult carries one replica's outcome back to FetchFastest.
type replicaResult struct {
	value string
	err   error
}

// FetchFastest calls every replica concurrently (one goroutine each)
// and returns the value and error from whichever one sends on its own
// result channel FIRST - later stragglers are ignored. If done is
// closed before any replica has responded, FetchFastest returns early
// with an error and no winner.
func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {
	if len(replicas) == 0 {
		return "", errors.New("fetchfastest: no replicas provided")
	}

	// stop is the done channel every replica goroutine actually
	// receives. Closing it is how FetchFastest tells every
	// still-running replica "stop, you already lost (or the caller
	// gave up)". It is closed exactly once, on the way out of this
	// function, by the deferred close below - covering both the
	// "we have a winner" and "the caller's done fired" return paths.
	stop := make(chan struct{})
	defer close(stop)

	results := make(chan replicaResult, len(replicas))

	for _, replica := range replicas {
		go func(r Replica) {
			value, err := r(stop)
			results <- replicaResult{value: value, err: err}
		}(replica)
	}

	select {
	case res := <-results:
		return res.value, res.err
	case <-done:
		return "", errors.New("fetchfastest: cancelled before any replica responded")
	}
}

func main() {
	replicas := []Replica{
		NewMockReplica("replica-A", 150*time.Millisecond).Replica,
		NewMockReplica("replica-B", 10*time.Millisecond).Replica,
		NewMockReplica("replica-C", 300*time.Millisecond).Replica,
	}

	done := make(chan struct{})
	start := time.Now()

	value, err := FetchFastest(done, replicas...)

	fmt.Printf("winner after %s: value=%q err=%v\n", time.Since(start), value, err)
	fmt.Println("...and replica-A and replica-C were told to stop as soon as replica-B won,")
	fmt.Println("instead of running to completion in the background for nothing.")

	// Give the (now-cancelled) losing replicas a moment to actually
	// return before main exits, just so this demo doesn't race main's
	// own exit against their early-return bookkeeping.
	time.Sleep(20 * time.Millisecond)
}
```

Design notes:

- **One channel handles both cancellation sources.** Every replica receives `stop` as its `done`. `defer close(stop)` runs on every return path from `FetchFastest`. A future return path cannot forget to stop the replicas.
- **The `select` chooses the first result.** A caller cancellation or a replica result both end the call.
- **Buffer `results` to `len(replicas)`.** A losing replica still sends `results <- replicaResult{...}`. An unbuffered channel would block every loser forever. The goroutine would still not exit. The buffer guarantees room for every send.
- **A cancellable send is another correct option.** Use `select { case results <- r: case <-stop: }`.
- **Incorrect buffering fails hard under `synctest`.** An unbuffered `results` uses `make(chan replicaResult)`. That makes `TestFetchFastestReturnsFastestValue` panic with `deadlock: main bubble goroutine has exited but blocked goroutines remain`. The blocked goroutines sit at `results <- replicaResult{...}`. Their tag is `chan send (durable)`.
- **Replicas only need the stop signal.** `stop` has no payload and no reason. One `case <-done:` arm is enough.

**Verified:** `go build ./...` and `go vet ./...` are clean. `go test -race -count=5 ./...` and `go test -race -count=15 ./...` pass all five tests every time. The real `28-replicated-requests/main.go` stayed unchanged.

The runs include the two `synctest` cancellation tests. They also include `TestFetchFastestReturnsWinnerError` and the 20-goroutine `TestFetchFastestConcurrentSafety`.

## Approach 2: `context.WithCancel` with a bridge goroutine (alternative)

This version uses a `context.Context`. Each replica receives `ctx.Done()` instead of a raw `chan struct{}`.

```go {40-46,52}
package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type Replica func(done <-chan struct{}) (string, error)

type replicaResult struct {
	value string
	err   error
}

// FetchFastest calls every replica concurrently (one goroutine each)
// and returns the value and error from whichever one sends on its own
// result channel FIRST - later stragglers are ignored. If done is
// closed before any replica has responded, FetchFastest returns early
// with an error and no winner.
//
// This version cancels the losers via a context.Context instead of a
// plain channel. Since Replica takes a <-chan struct{} rather than a
// context.Context, ctx.Done() is handed to each replica directly (it
// already has exactly that type), and a small bridge goroutine
// forwards the caller's done into ctx's cancellation.
func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {
	if len(replicas) == 0 {
		return "", errors.New("fetchfastest: no replicas provided")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // covers both return paths below, same as Approach 1's defer close(stop)

	// Bridge: turn the caller-supplied done into ctx cancellation.
	// This goroutine always exits on its own once FetchFastest
	// returns - either done fired (the case it's waiting on) or
	// cancel() fired first (ctx.Done() case), so it never leaks.
	go func() {
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()

	results := make(chan replicaResult, len(replicas))

	for _, replica := range replicas {
		go func(r Replica) {
			value, err := r(ctx.Done())
			results <- replicaResult{value: value, err: err}
		}(replica)
	}

	select {
	case res := <-results:
		return res.value, res.err
	case <-done:
		return "", errors.New("fetchfastest: cancelled before any replica responded")
	}
}

func main() {
	replicas := []Replica{
		NewMockReplica("replica-A", 150*time.Millisecond).Replica,
		NewMockReplica("replica-B", 10*time.Millisecond).Replica,
		NewMockReplica("replica-C", 300*time.Millisecond).Replica,
	}

	done := make(chan struct{})
	start := time.Now()

	value, err := FetchFastest(done, replicas...)

	fmt.Printf("winner after %s: value=%q err=%v\n", time.Since(start), value, err)
	fmt.Println("...and replica-A and replica-C were told to stop as soon as replica-B won,")
	fmt.Println("instead of running to completion in the background for nothing.")

	time.Sleep(20 * time.Millisecond)
}
```

Design notes and differences from Approach 1:

- **`ctx.Done()` already has type `<-chan struct{}`.** That is the type `Replica` expects. Replicas need no change.
- **`Context` can carry deadlines and request values.**
  `context.WithTimeout` adds a deadline. This prose also calls it
  `WithTimeout`. `WithValue` adds a request value. It can connect to
  `req.WithContext`. This version uses only `context.WithCancel`.
- **This version needs a bridge goroutine.** The caller provides a `done chan struct{}`. `context.Context` cannot cancel when that channel closes. The bridge waits on `case <-ctx.Done()`. Use `select { case <-done: cancel() case <-ctx.Done(): }`.
- **The bridge must exit on both return paths.** A replica win runs `defer cancel()`. That makes `ctx.Done()` fire. If the caller's `done` closes first, the bridge calls `cancel()`. Calling `cancel` more than once is safe.
- **The `ctx` value is local to one call.** Cancel it with `defer`.
- **You need no `if` or `else` for cleanup.** One deferred call covers both return paths.
- **Use context when the surrounding code already uses it.** A real HTTP or gRPC call can take a `context.Context` directly. With this exercise's `done <-chan struct{}` signature, one shared channel is simpler.

A per-replica `done` channel also works. Use a `[]chan struct{}` sized to `len(replicas)` and close each one in a loop. It behaves like one shared `stop`, but needs more state and code. One shared channel already tells every replica to stop.

**Verified:** `go build ./...` and `go vet ./...` are clean. `go test -race -count=10 ./...` passes all five tests every time. The runs include the cancellation, winner-error, and 20-goroutine tests.

## Key takeaways

- The caller's `done` and each replica's `done` are two cancellation sources. Both must reach every active replica.
- The bug is not a missing cancel call. The code passes `nil`, so cancellation can never reach a replica.
- `defer close(stop)` runs on every return path. Use `defer cancel()` with a context.
- Buffer `results` to `len(replicas)`, or make each send cancellable. Otherwise, losers stop working but block forever on a send.
- `-race` does not catch this leak. Check that goroutines actually exit.
