# Batch Collector: Coalescing N Concurrent Calls Into One Batch API Request — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

`Add` mutates shared state with **no synchronization**:

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

**Verified**: running `check_test.go` against this in a scratch copy
crashes outright on corrupted slices (two goroutines both extending
`c.requests`, one overwriting the other's growth):

```
=== RUN   TestCollectorFiresBatchExactlyOnceAndMapsResultsCorrectly
panic: runtime error: index out of range [29] with length 29
    .../36-batch-collector/main.go:116 +0xdc
FAIL
```

Under `-race`, one of `TestCollectorPropagatesErrorToAllCallers`'s ten
callers times out waiting on a `Result` that never arrives — a lost
`nQueued++` meant `execute` never fired for that batch.

## The fix: a mutex, and a decision about WHEN to fire

The append-and-count needs a `sync.Mutex`. But there are two
materially different, both-correct answers to "when does `fn` fire?"

### Approach 1: hold the lock across the whole batch call

```go
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.mu.Lock()
	defer c.mu.Unlock()

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	c.nQueued++

	if c.nQueued >= c.expected {
		c.execute() // still holding c.mu
	}
	return ch
}
```

```
Add(A) ──lock──▶ append, nQueued++ ──not yet expected──▶ unlock
Add(B) ──lock──▶ append, nQueued++ ──== expected──▶ execute() ──▶ unlock
Add(C) ──lock (blocked until B's unlock, i.e. until fn already ran)
```

Holding the lock from the first append through `execute` makes
"reach-threshold, then fire" one atomic unit — only the one goroutine
that pushed `nQueued` to `expected` can ever observe it and call `fn`.
A second `execute` for the same batch is structurally impossible. This
is what `gocommon`'s own `ConcurrentBatcher.execute` does.

Tradeoff: every `Add` is serialized behind whichever one is running
`fn` — fine when `fn` is fast, worth watching if it's slow.

### Approach 2: a `fired` flag, lock released before calling `fn`

```go
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
		c.execute(requests, resultChs) // fn runs WITHOUT the lock held
	}
	return ch
}
```

The lock only ever guards bookkeeping. `fired` is what closes the
TOCTOU gap: it flips `false → true` atomically under the lock, so only
the one goroutine that flips it ever sees `shouldFire = true` — every
other `Add`, however close the timing, either hasn't reached `expected`
or finds `fired` already set. The snapshot of `requests`/`resultChs`
taken under the lock and passed as plain arguments keeps `execute` from
reading those fields concurrently with any future mutation.

Both verified clean:

```
go test -race .   # Approach 1 and Approach 2, independently
PASS
```

## The double-fire trap

Tempting "fix" that removes the data race but not the logic race:

```go
c.mu.Lock()
c.requests = append(c.requests, request)
c.resultChs = append(c.resultChs, ch)
c.nQueued++
c.mu.Unlock()

if c.nQueued >= c.expected {   // BUG: read outside the lock, no flag
	c.execute()
}
```

```
goroutine A: nQueued++ (→ expected)     goroutine B: nQueued++ (still == expected)
   unlock ──▶ read nQueued >= expected ──▶ true    unlock ──▶ read nQueued >= expected ──▶ true
        │                                                │
        ▼                                                ▼
     execute()  ◀──── fn runs TWICE for the same batch ────▶  execute()
```

Every write is now inside the lock, but two goroutines can both read
`true` right after each other and both call `execute` — `fn` runs
twice, and each buffered-1 channel receives twice (the second send
blocks forever, or silently races the first). Fix: keep the fire
*decision* inside the same critical section as the count check
(Approach 1), or make the decision itself race-proof with a flag set
under the lock before it's ever read outside it (Approach 2).

## Why this contrasts with 35

[35](../35-singleflight)'s rule was "never hold the mutex across the
call to `fn`" — unrelated keys must never wait on each other. Here,
Approach 1 holding the lock across `fn` is exactly what makes "exactly
once" trivial — because unlike `singleflight`, every caller in a batch
**is already waiting on this exact operation**; there's no unrelated
key to unblock. Whether the lock should span the slow call depends on
whether the callers you'd block are already waiting on that call
anyway.

## Key takeaways

- A mutex around the *mutation* isn't enough if the *fire decision* is
  read back outside the same critical section — that reopens the race
  one level up.
- "Hold the lock across the slow call" vs. "release it, gate with a
  flag" are both valid; pick based on whether blocked callers were
  already waiting on that call's result.
