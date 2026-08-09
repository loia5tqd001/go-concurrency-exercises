# Batch Collector: Coalescing N Concurrent Calls Into One Batch API Request — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `36-batch-collector/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

The starting point is a `Collector` whose `Add` mutates shared state with **no synchronization at all**:

```go
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	c.nQueued++

	if c.nQueued >= c.expected {
		c.execute()
	}

	return ch
}
```

`Add` must:

- Register `request`, and hand back a channel that later receives exactly one `Result`.
- Run `fn` **exactly once**, only once the `expected`-th call to `Add` has arrived, with every request added so far.
- Deliver each response back to the caller whose request produced it — not some other caller's.
- Share a single error with every caller in the batch, if `fn` fails.
- Be safe to call concurrently, from any number of goroutines.

## Why the naive version is wrong

`c.requests = append(...)`, `c.resultChs = append(...)`, and `c.nQueued++` are three unsynchronized reads/writes of shared state, hit concurrently by every goroutine calling `Add`. This doesn't just fail quietly — it fails in whichever of three ways the scheduler happens to land on:

Verified: running the current `check_test.go` against this naive `main.go` in a throwaway scratch copy —

```
=== RUN   TestCollectorSingleRequest
--- PASS: TestCollectorSingleRequest (0.00s)
=== RUN   TestCollectorFiresBatchExactlyOnceAndMapsResultsCorrectly
panic: runtime error: index out of range [29] with length 29
    .../36-batch-collector/main.go:116 +0xdc
FAIL
```

— crashes outright on corrupted slices (two goroutines both extending `c.requests` at the same array index, one overwriting the other's growth). `TestCollectorSingleRequest` passes because it never has more than one goroutine touching `Collector` at a time — a single caller can't race with itself. Run the concurrent tests again under `-race` and, even on a pass that doesn't happen to panic, the race detector still flags the unsynchronized writes and one of the ten `TestCollectorPropagatesErrorToAllCallers` callers times out waiting on a `Result` that never arrives — a lost `nQueued++` increment meant `execute` never fired for that batch at all.

## The fix: a mutex, and a decision about WHEN to fire

The append-and-count needs a `sync.Mutex`. But there are two materially different, both-correct ways to decide when to call `fn`, and the difference matters.

### Approach 1: hold the lock across the whole batch call

```go
type Collector struct {
	mu        sync.Mutex
	expected  int
	fn        BatchFunc
	requests  []int
	resultChs []chan Result
	nQueued   int
}

func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.mu.Lock()
	defer c.mu.Unlock()

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	c.nQueued++

	if c.nQueued >= c.expected {
		c.execute()
	}

	return ch
}

func (c *Collector) execute() {
	responses, err := c.fn(c.requests)

	for i, resultCh := range c.resultChs {
		if err != nil {
			resultCh <- Result{Err: err}
			continue
		}
		resultCh <- Result{Value: responses[i]}
	}
}
```

Because the lock is held from the first append all the way through `execute`, the read-modify-check-and-fire sequence is one atomic unit. Only the one goroutine whose `Add` call pushed `nQueued` to `expected` can ever observe that condition and call `fn` — every other `Add` call is fully serialized behind it, so a second call to `execute` for the same batch is structurally impossible. This is exactly what `gocommon`'s own `ConcurrentBatcher.execute` does (it's called from inside `Add`/`Cancel` while still holding `cb.lock`).

The tradeoff: every `Add` call for a batch is serialized behind whichever one happens to be running `fn` — the last caller to arrive blocks every future caller (there are none left in this exercise's contract, but in a design that reused a `Collector` across multiple batches, this would matter) until the batch call returns. Fine when `fn` is reasonably fast; something to watch if `fn` is slow and the type needs to stay responsive to unrelated work.

### Approach 2: a `fired` flag, lock released before calling `fn`

```go
type Collector struct {
	mu        sync.Mutex
	expected  int
	fn        BatchFunc
	requests  []int
	resultChs []chan Result
	nQueued   int
	fired     bool
}

func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.mu.Lock()

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	c.nQueued++

	shouldFire := c.nQueued >= c.expected && !c.fired
	if shouldFire {
		c.fired = true
	}

	requests, resultChs := c.requests, c.resultChs
	c.mu.Unlock()

	if shouldFire {
		c.execute(requests, resultChs)
	}

	return ch
}

func (c *Collector) execute(requests []int, resultChs []chan Result) {
	responses, err := c.fn(requests)

	for i, resultCh := range resultChs {
		if err != nil {
			resultCh <- Result{Err: err}
			continue
		}
		resultCh <- Result{Value: responses[i]}
	}
}
```

Here the lock only ever guards the bookkeeping — the append, the counter, and a `fired` flag that's set to `true` **before** the lock is released. That flag is what closes the TOCTOU gap: even though the "should I fire?" decision and the actual `execute` call are no longer under the same lock acquisition, only the one goroutine that atomically flipped `fired` from `false` to `true` while holding the lock ever gets `shouldFire = true`. Every other concurrent `Add` call, however close the timing, either hasn't reached `expected` yet or finds `fired` already `true` and does nothing further. The snapshot of `c.requests`/`c.resultChs` taken under the lock, passed into `execute` as plain arguments, keeps `execute` from reading those fields concurrently with any future mutation.

Both are verified clean:

```
go test -race .        # Approach 1 and Approach 2, independently
--- PASS: TestCollectorSingleRequest
--- PASS: TestCollectorFiresBatchExactlyOnceAndMapsResultsCorrectly
--- PASS: TestCollectorPropagatesErrorToAllCallers
PASS
```

## The double-fire trap, and why this contrasts with 35

It's tempting to "fix" the race by locking just the three mutations and unlocking immediately, then checking the fire condition afterward:

```go
c.mu.Lock()
c.requests = append(c.requests, request)
c.resultChs = append(c.resultChs, ch)
c.nQueued++
c.mu.Unlock()

if c.nQueued >= c.expected {   // BUG: read outside the lock, and no flag to prevent two winners
	c.execute()
}
```

This removes the *data race* (every write is now inside the lock) but not the *logic race*: two goroutines can both read `c.nQueued >= c.expected` as true right after each other, and both call `execute` — `fn` runs twice for the same batch, each caller's channel receives twice (blocking forever on the second send, since the channel is buffered 1), or worse, whichever channel fills first wins and the second write silently blocks. The fix is either of the two approaches above: keep the fire *decision* inside the same critical section as the *count check* (Approach 1), or make the decision itself race-proof with a flag set under the lock before it's ever consulted outside of it (Approach 2).

This is a deliberate inversion of [35](../35-singleflight)'s lesson. There, the rule was "never hold the mutex across the call to `fn`" — `singleflight.Do` locks only for the map lookup/insert/delete, and relies on `sync.WaitGroup` as a separate join mechanism so unrelated keys never wait on each other. Here, in Approach 1, holding the lock across `fn` is exactly what makes "exactly once" trivial to guarantee — because unlike `singleflight`, every caller in a `Collector` batch **is** already waiting on the exact same operation; there's no "unrelated key" to unblock. There's no one-size-fits-all rule for "should the lock span the slow call" — it depends on whether the callers you'd be blocking are already, by construction, waiting on that exact call anyway.
