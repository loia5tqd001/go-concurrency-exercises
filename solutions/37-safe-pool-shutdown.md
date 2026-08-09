# Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `37-safe-pool-shutdown/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

The starting point is a `Pool` with zero coordination between `Submit` and `Close`:

```go
func (p *Pool) Submit(job func()) (accepted bool) {
	p.wg.Add(1)
	p.jobs <- job
	return true
}

func (p *Pool) Close() {
	p.wg.Wait()
	close(p.jobs)
}
```

`Submit` must be safe to call concurrently with `Close`, from any number of goroutines, without ever panicking; it must return `accepted = true` and guarantee `job` runs if called before the pool finished closing, or `accepted = false` if the pool was already closed. `Close` must not return until every accepted job has actually finished.

## Why the naive version is wrong

Verified: running the current `check_test.go` against this naive `main.go` in a throwaway scratch copy fails deterministically, every single run:

```
--- FAIL: TestSubmitAfterCloseIsRejectedNotPanicked
    check_test.go:100: Submit panicked: send on closed channel - Submit must never panic, even after Close has already returned
    (× 50, once per post-close Submit call)
FAIL
```

That test doesn't even need to win a race: it submits a few jobs, calls `Close`, **waits for `Close` to fully return**, and only then fires a burst of `Submit` calls. By that point `p.jobs` is unconditionally closed, and `Submit` unconditionally sends on it - there is no timing involved, it fails 10/10 runs, with or without `-race`. `TestConcurrentSubmitDuringCloseNeverPanics` (submitters racing a concurrent `Close`) is the messier, real-world version of the same bug, and needs `-race`'s scheduling slowdown to hit reliably, but the deterministic test above is what makes the failure obvious without depending on luck.

## The fix: `sync.RWMutex`-guarded `closed` flag

```go
type Pool struct {
	mu     sync.RWMutex
	closed bool
	jobs   chan func()
	wg     sync.WaitGroup
}

func (p *Pool) Submit(job func()) (accepted bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.closed {
		return false
	}

	p.wg.Add(1)
	p.jobs <- job
	return true
}

func (p *Pool) Close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()

	p.wg.Wait()
	close(p.jobs)
}
```

The mechanism:

- **`Submit` holds a read lock across its ENTIRE body, including the blocking send** - not just the `closed` check. Multiple `Submit` calls can hold that read lock concurrently (that's the whole point of `RWMutex` over a plain `Mutex`: unrelated submitters don't serialize against each other), but every single one of them is guaranteed to have either fully completed its send or not yet started, whenever no read lock is held at all.
- **`Close` takes the exclusive write lock just to flip `closed = true`.** `mu.Lock()` cannot succeed while *any* `Submit` call still holds a read lock - meaning by the time `Close` gets past that `Lock()`/`Unlock()` pair, every `Submit` call that had already started is guaranteed to have finished its send (and therefore its `wg.Add(1)`) before `closed` became visible as `true`. No `Submit` call can ever observe `closed == false`, pass the check, and then have the channel yanked out from under it before it sends - the mutex makes that interleaving impossible.
- **Once `closed` is `true`, every subsequent `Submit` call sees it and returns `false` before ever touching `p.jobs`.** `close(p.jobs)` is therefore only ever called once nobody could possibly still be sending on it.
- **`wg.Wait()` runs before `close(p.jobs)`**, not after. This isn't about safety (the mutex already guarantees no one is sending once we reach this line) - it's what makes `Close` synchronous: without it, `Close` could return the instant the channel closes, while a worker is still mid-`job()` call on something it had already dequeued. The `sync.WaitGroup` here is `Add`ed once per accepted job (inside the same critical section as the send, so `Add` always happens-before any possible `Wait`) and `Done`d by the worker only after `job()` actually returns.

Verified clean, repeatedly, with both the deterministic and racy tests:

```
go test -count=20 .        # 20/20 clean
go test -race -count=20 .  # 20/20 clean
```

## The `recover`-in-`Submit` trap

The README calls this out directly because it's the single most tempting near-miss:

```go
func (p *Pool) Submit(job func()) (accepted bool) {
	defer func() {
		if recover() != nil {
			accepted = false
		}
	}()
	p.wg.Add(1)
	p.jobs <- job
	return true
}
```

This stops the panic from escaping `Submit` - but `wg.Add(1)` already ran before the panicking send, and nothing ever calls the matching `Done()` for that particular job, since it was never delivered to a worker. `Close`'s `wg.Wait()` is left waiting on a counter that can never reach zero again: `Close` hangs forever. `check_test.go`'s `closeWithTimeout` helper exists specifically to turn that hang into a fast, readable test failure (`"Close did not return within 3s"`) instead of a 10-minute `go test` timeout with no clue why.

If you insist on making a `recover`-based fix actually correct, you'd need to also undo the `Add` on the recovered path (`p.wg.Done()` inside the `recover` branch) - at which point you've reconstructed, by hand and with panic/recover as your control flow, something strictly worse than just checking a flag before you ever attempt the send. Prevention beats cleanup here.

## A related trap, seen in the real-world version of this pattern

This exercise is modeled on a `sync.RWMutex`-guarded worker pool from a production Go codebase, and that pool's `Offer` method (a non-blocking `Submit` variant that gives up instead of waiting for a free worker) has a genuine ordering bug worth knowing about, precisely because it's easy to introduce by accident when you're refactoring `Submit` into a non-blocking version:

```go
select {
case execChan <- f:
	wait.Add(1)   // BUG: Add happens AFTER the send has already succeeded
	return true
default:
	return false
}
```

Compare that to this exercise's `Submit`, which does `p.wg.Add(1)` **before** `p.jobs <- job`. The ordering matters: the instant a value is sent into `execChan`, a worker can receive it, run it, and call `wait.Done()` - all before the sender's own next line, `wait.Add(1)`, has had a chance to execute. `sync.WaitGroup`'s documentation is explicit that this is not allowed: calls to `Add` with a positive delta must happen before the corresponding `Wait` call observes the counter reach zero, and a `Done` racing ahead of its own `Add` can drive the counter negative - which panics - or let a concurrent `Wait` return while that job is still (about to be) in flight. If you write a non-blocking `Offer` alongside this exercise's `Submit`, double-check that `Add` still comes first in both.
