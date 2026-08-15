# Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

Zero coordination between `Submit` and `Close`:

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

**Verified**: this fails deterministically, every run, no `-race`
needed — `TestSubmitAfterCloseIsRejectedNotPanicked` submits a few
jobs, calls `Close`, **waits for it to fully return**, then fires a
burst of `Submit` calls against an already-closed channel:

```
--- FAIL: TestSubmitAfterCloseIsRejectedNotPanicked
    Submit panicked: send on closed channel (× 50, once per post-close Submit call)
```

`TestConcurrentSubmitDuringCloseNeverPanics` is the messier real-world
version (submitters racing a concurrent `Close`) and needs `-race`'s
scheduling slowdown to hit reliably — but the test above proves the
bug without depending on luck.

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
	p.jobs <- job // still holding the READ lock
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

```
Submit A: RLock ──▶ !closed ──▶ wg.Add(1) ──▶ jobs<-job ──▶ RUnlock
Submit B: RLock ──▶ !closed ──▶ wg.Add(1) ──▶ jobs<-job ──▶ RUnlock   (both hold RLock concurrently — fine)
Close:              Lock() ◀── blocks until EVERY RLock above is released
                       │
                    closed = true, Unlock
                       │
                 wg.Wait() ──▶ close(p.jobs)   ← only now, guaranteed no Submit still sending
```

- **`Submit` holds a read lock across its whole body, including the
  blocking send** — not just the `closed` check. Multiple `Submit`
  calls hold that read lock concurrently (the point of `RWMutex` over
  plain `Mutex`), but every one is guaranteed to have either fully sent
  or not started, whenever no read lock is held at all.
- **`Close` takes the write lock just to flip `closed = true`.**
  `mu.Lock()` can't succeed while any `Submit` still holds a read lock
  — so by the time `Close` gets past it, every already-started `Submit`
  has finished its send (and its `wg.Add(1)`) before `closed` became
  visible as `true`. No `Submit` can see `closed == false`, pass the
  check, and then have the channel yanked out before it sends.
- **Once `closed` is `true`**, every later `Submit` sees it and returns
  `false` before touching `p.jobs` — so `close(p.jobs)` only ever runs
  once nobody could possibly still be sending.
- **`wg.Wait()` before `close(p.jobs)`** is what makes `Close`
  synchronous — not safety (the mutex already guarantees no sender),
  but correctness of "returns only once every job has *finished*", not
  merely dequeued. `Add` happens inside the same critical section as
  the send, so it always happens-before any possible `Wait`.

**Verified** clean, repeatedly: `go test -count=20 .` and
`go test -race -count=20 .`, both 20/20.

## The `recover`-in-`Submit` trap

The single most tempting near-miss:

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

```
wg.Add(1) ──▶ jobs<-job ──▶ PANIC ──▶ recover() swallows it, accepted=false
     │                                              │
 counter incremented                    no matching Done() — job never
                                         reached a worker
                                              │
                              Close's wg.Wait() hangs forever
```

This stops the panic escaping `Submit`, but `wg.Add(1)` already ran
before the panicking send, and nothing ever `Done()`s it — `Close`
hangs forever. `check_test.go`'s `closeWithTimeout` helper exists
specifically to turn that hang into a fast, readable failure
(`"Close did not return within 3s"`) instead of a silent 10-minute `go
test` timeout. Fixing `recover` properly means adding a compensating
`p.wg.Done()` on the recovered path — at which point you've rebuilt,
by hand with panic/recover as control flow, something strictly worse
than just checking a flag before attempting the send.

## A related trap, seen in a real-world version of this pattern

This exercise is modeled on a production `sync.RWMutex`-guarded worker
pool whose non-blocking `Offer` variant has a genuine ordering bug,
easy to introduce when refactoring `Submit` into a non-blocking form:

```go
select {
case execChan <- f:
	wait.Add(1) // BUG: Add happens AFTER the send already succeeded
	return true
default:
	return false
}
```

Compare this exercise's `Submit`, which does `wg.Add(1)` **before**
`p.jobs <- job`. The moment a value is sent, a worker can receive it,
run it, and call `wait.Done()` — all before the sender's own next
line, `wait.Add(1)`, executes. `sync.WaitGroup`'s docs are explicit:
`Add` with a positive delta must happen before the corresponding
`Wait` observes zero — a `Done` racing ahead of its own `Add` can drive
the counter negative (panics) or let a concurrent `Wait` return while
that job is still in flight. If you write a non-blocking `Offer`
alongside this exercise's `Submit`, double-check `Add` still comes
first in both.

## Key takeaways

- `RWMutex` held across a blocking send is a legitimate pattern here:
  many readers (`Submit`s) may proceed concurrently, but the single
  writer (`Close`) is guaranteed none are mid-send once it gets the
  lock.
- `recover` hides a panic's *symptom*; it doesn't undo the bookkeeping
  that already ran before the panic. Prevent the race instead of
  catching its crash.
- `wg.Add` must happen-before the send that could let the corresponding
  `wg.Done` run — never after.
