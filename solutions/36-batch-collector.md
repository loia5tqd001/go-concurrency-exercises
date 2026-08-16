# Batch Collector: A Reusable Batcher With a Deadline and a Real Shutdown — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## Why this exercise changed shape

The original version of 36 was a one-shot join: `NewCollector(expected,
fn)` fired exactly once and was done. That's a fine teaching device for
the double-fire race, but it quietly assumed callers always stop
calling `Add` exactly at `expected` — an assumption that turned out to
be the exercise's own weakest point (a caller that keeps calling `Add`
past that point either wedges the whole `Collector` or leaks a
goroutine per late caller, depending on which fix you picked). Rather
than patch that gap in place a second time, this version goes the rest
of the way to what a real batching client actually looks like — the
shape a Kafka producer's `linger.ms`, a Google Pub/Sub publisher's
`DelayThreshold`/`CountThreshold`, or Segment's analytics client all
converge on: batches fire on a count *or* a deadline, whichever comes
first, the collector keeps running indefinitely instead of being spent
after one batch, and shutdown is an explicit, `context`-bounded
operation modeled directly on `net/http.Server.Shutdown`.

## The problem

`Add` mutates shared state with **no synchronization**, `MaxWait` is
declared in `Config` but never read, and `Close` is a bare flag flip:

```go
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)
	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	if len(c.requests) >= c.cfg.MaxBatchSize {
		c.execute()
	}
	return ch
}

func (c *Collector) Close(ctx context.Context) error {
	c.closed = true
	return nil
}
```

**Verified**, three separate ways:

Concurrent `Add` calls race on the shared slices — lost appends mean
the count never reaches `MaxBatchSize`, so `fn` never runs and every
caller in that batch hangs until the test's own timeout:

```
=== RUN   TestCollectorFiresOnMaxBatchSize
    check_test.go:68: timed out after 2s waiting for a Result - the batch likely never fired
    check_test.go:78: caller 1: got 0, want 2
    check_test.go:85: fn ran 0 time(s), want exactly 1
    testing.go:1617: race detected during execution of test
--- FAIL: TestCollectorFiresOnMaxBatchSize (2.00s)
```

`MaxWait` being ignored means a batch short of `MaxBatchSize` waits
forever, not just until its deadline:

```
=== RUN   TestCollectorFiresOnMaxWaitWithPartialBatch
    check_test.go:82: timed out after 2s waiting for a Result
--- FAIL: TestCollectorFiresOnMaxWaitWithPartialBatch (2.00s)
```

`Close` not checking its own flag in `Add`, nor flushing anything,
means a request added right after `Close` returns just sits in a batch
nobody will ever fire:

```
=== RUN   TestCollectorCloseRejectsSubsequentAdds
    check_test.go:221: timed out after 2s waiting for a Result
--- FAIL: TestCollectorCloseRejectsSubsequentAdds (2.00s)
```

## The fix

### Data model: one struct per batch, not scattered fields

The one-shot version kept `requests`/`resultChs`/`nQueued` directly on
`Collector`. A rolling batcher needs each batch to have its own
identity — its own slice, its own deadline timer, its own "have I
already fired" flag — so that firing one batch and opening the next
doesn't require resetting fields out from under whatever the *next*
batch has already started accumulating:

```go
type batch struct {
	requests  []int
	resultChs []chan Result
	timer     *time.Timer
	fired     bool
}

type Collector struct {
	cfg Config
	fn  BatchFunc

	mu       sync.Mutex
	batch    *batch // the currently-open batch, nil if none
	closed   bool
	inflight sync.WaitGroup // batches that have fired but not finished fn yet
}
```

### Add: open-or-join, fire on count, never touch a closed Collector

```go
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()
		ch <- Result{Err: ErrCollectorClosed}
		return ch
	}

	b := c.openBatch()
	b.requests = append(b.requests, request)
	b.resultChs = append(b.resultChs, ch)

	var fire bool
	if len(b.requests) >= c.cfg.MaxBatchSize {
		fire = c.detach(b)
	}
	c.mu.Unlock()

	if fire {
		c.startExecute(b)
	}
	return ch
}

// openBatch returns the batch new requests should join, opening a
// fresh one (and arming its deadline timer, if configured) if none is
// currently open. Must be called with c.mu held.
func (c *Collector) openBatch() *batch {
	if c.batch != nil {
		return c.batch
	}
	b := &batch{}
	c.batch = b
	if c.cfg.MaxWait > 0 {
		b.timer = time.AfterFunc(c.cfg.MaxWait, func() { c.onDeadline(b) })
	}
	return b
}
```

`MaxWait <= 0` deliberately means "no deadline, count-only" — a nice
real-world default rather than an accidental instant-fire on the first
request.

### detach: the one gate all three triggers share

```go
// detach marks b as fired - idempotent, only the first caller (from
// whichever trigger: count reached, deadline, or Close) ever gets
// true back - and detaches it from c.batch if it's still current.
// Must be called with c.mu held.
func (c *Collector) detach(b *batch) bool {
	if b.fired {
		return false
	}
	b.fired = true
	if b.timer != nil {
		b.timer.Stop()
	}
	if c.batch == b {
		c.batch = nil
	}
	c.inflight.Add(1)
	return true
}

func (c *Collector) onDeadline(b *batch) {
	c.mu.Lock()
	fire := c.detach(b)
	c.mu.Unlock()

	if fire {
		c.startExecute(b)
	}
}

func (c *Collector) startExecute(b *batch) {
	go func() {
		defer c.inflight.Done()
		c.executeBatch(b)
	}()
}

func (c *Collector) executeBatch(b *batch) {
	responses, err := c.fn(b.requests)
	for i, resultCh := range b.resultChs {
		if err != nil {
			resultCh <- Result{Err: err}
			continue
		}
		resultCh <- Result{Value: responses[i]}
	}
}
```

This is the same discipline the original 36 taught for its single
double-fire race, applied to three trigger sources instead of one:
whichever of {count reached inside `Add`, deadline timer, `Close`}
gets to `detach(b)` first is the only one that ever sees `b.fired ==
false`. `c.batch == b` guards against a *different* hazard covered
below — clobbering a newer batch that's already open by the time a
stale trigger for an old one gets the lock.

`fn` itself runs **outside** the lock, in its own goroutine, so `Add`
never blocks waiting for a slow `fn` call — a deliberate difference
from the original 36's Approach 1. There, holding the lock across `fn`
was fine because nothing else was ever going to call `Add` again once
the one batch fired. Here it would be actively harmful: the whole point
of rolling to a new batch immediately is that callers for the *next*
batch shouldn't have to wait for the *previous* batch's `fn` to finish.

### Why `Timer.Stop()` alone doesn't close the race

The count-trigger path calls `b.timer.Stop()` the moment it detaches a
batch — but the Go documentation for `Timer.Stop` is explicit that this
doesn't guarantee the timer's function isn't *already* running:

> For a timer created with `AfterFunc(d, f)`, if `t.Stop()` returns
> `false`... if the call happens after the current expiration time,
> `f` has already been started in its own goroutine.

That's exactly why `detach`'s `b.fired` check has to be the real gate,
not `Stop()`'s return value: even if `Stop()` runs a nanosecond before
the timer would have fired, the deadline goroutine may already be
blocked on `c.mu.Lock()` inside `onDeadline`, about to call `detach`
right after the count-trigger releases it. `detach` seeing `b.fired ==
true` already set is what turns that into a harmless no-op instead of
a second `fn` call.

### The stale-timer-vs-newer-batch trap

A batch's deadline timer captures `b` — the specific batch object — in
its closure, not "whatever `c.batch` happens to be when the timer
fires." That matters because by the time a slow-to-fire deadline
callback finally acquires `c.mu`, the Collector may have already rolled
over to one, two, or more newer batches. `detach`'s `if c.batch == b`
check is what prevents a stale timer from clobbering a batch it has
nothing to do with:

```
batch A opens, timer armed for 50ms
batch A fires by COUNT after only 5ms - c.batch is now nil, batch B opens
                                                     │
                        (batch B fires too, batch C opens)
                                                     │
        45ms later, batch A's stale timer finally fires - acquires c.mu
                                                     │
              detach(A): A.fired is already true → returns false, does
              nothing - crucially, does NOT touch c.batch, which is
              now batch C's problem entirely
```

Without the `c.batch == b` guard, this stale callback would either
wipe out batch C's in-progress accumulation (if it naively set
`c.batch = nil` unconditionally) or, worse, fire batch C early using
batch A's own (unrelated) request slice.

### Close: stop, flush, wait — bounded by ctx

```go
func (c *Collector) Close(ctx context.Context) error {
	c.mu.Lock()
	c.closed = true
	b := c.batch
	var fire bool
	if b != nil {
		fire = c.detach(b)
	}
	c.mu.Unlock()

	if fire {
		c.startExecute(b)
	}

	done := make(chan struct{})
	go func() {
		c.inflight.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
```

Three things happen in order, matching `net/http.Server.Shutdown`'s own
contract: `closed = true` stops any further `Add` from joining a batch
that will never be looked at again; detaching-and-firing whatever's
currently open turns a would-be-abandoned partial batch into one last
real `fn` call; and `inflight.Wait()`, raced against `ctx.Done()`,
means `Close` gives up waiting the moment `ctx` expires **without**
cancelling the batch itself — it keeps running to completion in the
background regardless, exactly like a slow in-flight HTTP handler
during `Shutdown`.

`Close` is naturally safe to call more than once or concurrently with
itself: `c.batch` is only ever non-nil for one still-open batch at a
time, and `detach`'s `b.fired` check means only the very first caller
(whichever of `Add`, a deadline, or `Close` gets there first) ever
actually fires it — every other concurrent `Close` just falls through
to waiting on the same `inflight` WaitGroup.

## The trap that only shows up under `-race`: `wg.Add` after `Unlock`

The most tempting way to write `detach` is to keep the bookkeeping
(`b.fired = true`, clearing `c.batch`) under the lock, but move
`c.inflight.Add(1)` down into `startExecute`, right next to the
`inflight.Done()` it's paired with:

```go
func (c *Collector) startExecute(b *batch) {
	c.inflight.Add(1) // BUG: moved out from under c.mu
	go func() {
		defer c.inflight.Done()
		c.executeBatch(b)
	}()
}
```

This *looks* harmless — `Add` and `Done` are still paired correctly for
this batch. The bug is in what it does to `Close`'s ordering guarantee.
`sync.WaitGroup`'s own docs are explicit: calls to `Add` with a
positive delta "must happen before" a `Wait` that could observe the
counter at zero. Once `inflight.Add(1)` moves outside the lock, nothing
orders it relative to a *different* goroutine's `Close` call — `Close`
can acquire `c.mu` (seeing `c.batch == nil`, because the firing
goroutine already cleared it), unlock, and start its own
`inflight.Wait()` **before** the firing goroutine's `Add(1)` has
actually executed:

```
goroutine A (fires batch b): detach(b) under lock → b.fired=true,
                              c.batch=nil → UNLOCK
                                     │
                     (scheduler preempts A here, before it reaches
                      startExecute's Add(1))
                                     │
goroutine B (Close): LOCK → sees c.batch == nil → UNLOCK
                         → inflight.Wait() → counter is 0 right now →
                           returns immediately, Close returns nil
                                     │
                     A resumes, calls inflight.Add(1) - too late,
                     Close already told its caller everything was done
```

**Verified**: forcing exactly this race (many concurrent `Add` calls
racing a concurrent `Close`, repeated under `-race`) catches it
directly as a `sync.WaitGroup` misuse — not a hang, not a wrong value,
a `-race` failure on the very first internal field the runtime uses to
implement the WaitGroup:

```
WARNING: DATA RACE
Write at 0x00c0003ac078 by goroutine 118:
  (*Collector).Close.func1()
      main.go:162 +0x38

Previous read at 0x00c0003ac078 by goroutine 90:
  (*Collector).startExecute()
      main.go:121 +0x38
  (*Collector).Add()
--- FAIL: TestCollectorCloseConcurrentWithAdd (0.00s)
```

It reproduced on roughly 1 run in 100 under `-count=100 -race` — rare
enough to pass a casual `go test -race` a few times in a row and still
be wrong, which is exactly the kind of bug this exercise's
`TestCollectorCloseConcurrentWithAdd` (many concurrent `Add`s racing a
concurrent `Close`, repeated) exists to catch. The fix is simply
keeping `c.inflight.Add(1)` inside `detach`, still under `c.mu`, as
shown above — every `Add(1)` this way happens-before the critical
section of any `Close` call that could ever reach a corresponding
`Wait()`, because the mutex totally orders the two.

## A test-design note: a tiny `MaxWait` can legitimately split one intended batch into several

An early version of `TestCollectorNeverDoubleFiresWhenCountAndWaitRace`
used a very short `MaxWait` (1ms) with several goroutines racing to
fill one batch, and asserted `fn` ran exactly once. It failed
constantly — not because of a real double-fire, but because a 1ms
deadline is often shorter than it takes several goroutines to actually
get scheduled, so the first request's batch would legitimately fire
*by itself* before the second request even arrived, opening a second,
separate (and equally legitimate) batch for it. Two single-request
batches firing independently isn't a bug; the test's assumption that
they'd all land in one batch was just wrong for that timing.

The fix was to stop asserting "exactly one `fn` call" and instead
assert the invariant a *real* double-fire would actually violate: sum
the number of requests processed across every `fn` call in the trial,
and check it equals the number of requests submitted. A genuine
double-fire double-counts one request's batch; a legitimate split into
several small batches still processes each request exactly once. This
is a more robust check precisely because it doesn't care how many
batches the race happened to produce.

## Contrast with the original 36

The original one-shot `Collector`'s headline lesson was a deliberate
*inversion* of [35](../35-singleflight)'s "never hold the mutex across
the call to `fn`" rule — holding the lock across `fn` was fine there
because nothing else would ever call `Add` again. This version needs
the opposite discipline for the opposite reason: because a new batch
*should* be accepting requests while the previous one's `fn` is still
running, `fn` here runs deliberately unlocked, in its own goroutine,
closer to 35's own rule than to the original 36's. The two exercises
now bracket the same design question from both sides: hold the lock
across the slow call only when every caller you'd block is already
waiting on that exact call anyway - never when a *different* caller's
unrelated work is what's waiting behind the lock.

## Key takeaways

- A rolling batcher needs per-batch identity (a struct, not scattered
  counter fields) so that firing one batch and opening the next can't
  corrupt or get corrupted by whichever batch is currently open.
- Three trigger sources (count, deadline, explicit close) racing to
  fire the same batch need one shared gate (a `fired` flag, set inside
  the same critical section that reads it) — not three separate
  "did I win?" checks that can all say yes.
- `Timer.Stop()` returning doesn't mean the timer's function isn't
  already running or about to run; the real gate has to be state
  checked under the same lock, not the `Stop()` call's return value.
- `sync.WaitGroup.Add` must happen-before any `Wait` that could
  observe zero — which in practice means: if `Add` and the code that
  decides "should I start this work" are on opposite sides of an
  unlock, move `Add` to the side still holding the lock.
- `Close` bounded by `context.Context`, modeled on
  `net/http.Server.Shutdown`, is what makes "wait for graceful
  shutdown, but not forever" an explicit, testable contract instead of
  an unbounded `Wait()` a caller has no way to give up on.
