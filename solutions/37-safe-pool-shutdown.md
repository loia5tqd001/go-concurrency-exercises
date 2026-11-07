# Safe Pool Shutdown: Close a Multi-Producer Queue Without Panics — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The problem

There is no coordination between `Submit` and `Close`:

```go
func (p *Pool) Submit(job func()) (accepted bool) {
	p.jobs <- job
	return true
}

func (p *Pool) Close() {
	close(p.jobs)
}
```

**Verified**: this fails every run. It does not need `-race`.
`TestSubmitAfterCloseIsRejectedNotPanicked` submits a few jobs. It
calls `Close` and **waits for it to return**. Then it runs many
`Submit` calls on the closed channel:

```
--- FAIL: TestSubmitAfterCloseIsRejectedNotPanicked
    Submit panicked: send on closed channel (× 50, once per post-close Submit call)
```

`TestConcurrentSubmitDuringCloseNeverPanics` is a messier real-world
case. Submitters race a concurrent `Close`. It often needs `-race`'s
scheduling slowdown to fail reliably. The test above proves the bug
without luck.

## The fix: `sync.RWMutex`-guarded `closed` flag

```go {9,16,21,25}
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

func (p *Pool) worker() {
	for job := range p.jobs {
		job()
		p.wg.Done()
	}
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

- **Read lock:** `Submit` holds a read lock for its whole body,
  including the blocking send. It does not release the lock after the `closed`
  check. Multiple `Submit` calls can hold the read lock together. That
  is why this uses `RWMutex` instead of `Mutex`. When no read lock is
  held, every `Submit` has finished its send or not started.
- **Write lock:** `Close` takes the write lock only to set
  `closed = true`.
  `mu.Lock()` cannot succeed while a `Submit` holds a read lock. By the
  time `Close` passes it, every started `Submit` has finished its send
  and its `wg.Add(1)`. No `Submit` can see `closed == false`, pass the
  check, and lose `p.jobs` before its send.
- **Later calls:** Once `closed` is `true`, every later `Submit`
  returns `false` before touching `p.jobs`. So `close(p.jobs)` runs only when no
  sender can still exist.
- **Wait:** `wg.Wait()` before `close(p.jobs)` makes `Close` synchronous.
  The mutex already prevents senders, so this is not a safety fix. It
  makes `Close` wait until every job has finished, not just left the
  queue. `Add` is in the same critical section as the send. So it
  happens before any possible `Wait`.
- **Done pairing:** Every accepted job needs one matching `wg.Done()`
  after it finishes. Without that call in `worker`, the fix blocks in `Close`
  forever.

**Verified** repeatedly: `go test -count=20 .` and
`go test -race -count=20 .` both passed 20 of 20 runs.

## The `recover`-in-`Submit` trap

Here is the most tempting near miss:

```go {7,8}
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

This stops the panic from leaving `Submit`. But `wg.Add(1)` already ran
before the failed send. Nothing calls `Done()` for it. `Close` hangs
forever. The `closeWithTimeout` helper in `check_test.go` turns that
hang into a quick failure. The message is
`"Close did not return within 3s"` instead of a silent 10-minute
`go test` timeout. A proper `recover` fix would call `p.wg.Done()` on
the recovered path. That rebuilds the same check with panic and
recover as control flow. It is worse than checking a flag before the
send.

## A related trap, seen in a real-world version of this pattern

This exercise is modeled on a production `sync.RWMutex`-guarded worker
pool. Its non-blocking `Offer` variant has a real ordering bug. The
bug is easy to add when `Submit` becomes non-blocking.

```go {2,3}
select {
case execChan <- f:
	wait.Add(1) // BUG: Add happens AFTER the send already succeeded
	return true
default:
	return false
}
```

Compare this with the exercise's `Submit`, which calls `wg.Add(1)`
**before** `p.jobs <- job`. A worker can receive a job as soon as it is
sent. It can run it and call `wait.Done()` before the sender reaches
`wait.Add(1)`. The `sync.WaitGroup` docs say a positive `Add` must
happen before a matching `Wait` sees zero. A `Done` that runs before
its `Add` can make the counter negative and panic. It can also let a
concurrent `Wait` return while the job is in flight. If you add a
non-blocking `Offer`, make sure `Add` still comes first in both paths.

## Key takeaways

- Here, holding an `RWMutex` across a blocking send is valid. Many
  `Submit` calls can run together. The single `Close` writer gets the
  lock only after no `Submit` is mid-send.
- `recover` hides a panic's symptom. It does not undo bookkeeping that
  already ran. Prevent the race instead of catching its crash.
- `wg.Add` must happen before the send that can let the matching
  `wg.Done` run. Never after.
