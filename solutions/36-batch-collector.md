# Batch Collector: A Reusable Batcher With Deadlines and Shutdown — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The problem

`Add` does not batch anything. It calls `fn` right away with one
request. `Close` does nothing:

```go
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)
	responses, err := c.fn([]int{request})
	if err != nil {
		ch <- Result{Err: err}
	} else {
		ch <- Result{Value: responses[0]}
	}
	return ch
}

func (c *Collector) Close(ctx context.Context) error {
	return nil
}
```

The naive code fails in three separate ways.

`fn` runs once per request instead of once per batch. Batching never
happens:

```
=== RUN   TestCollectorFiresOnMaxBatchSize
    check_test.go:106: fn ran 5 time(s), want exactly 1
--- FAIL: TestCollectorFiresOnMaxBatchSize (0.00s)
```

The code ignores `MaxWait`. This does not show up as a hang. There is no
batch to wait for. It shows the same one-call-per-request symptom:

```
=== RUN   TestCollectorFiresOnMaxWaitWithPartialBatch
    check_test.go:135: fn ran 2 time(s), want exactly 1
--- FAIL: TestCollectorFiresOnMaxWaitWithPartialBatch (0.00s)
```

`Close` does not set anything that `Add` checks. A request can arrive
after `Close` returns and still go through.

```
=== RUN   TestCollectorCloseRejectsSubsequentAdds
    check_test.go:272: Add after Close: got err <nil>, want collector: closed
--- FAIL: TestCollectorCloseRejectsSubsequentAdds (0.00s)
```

## The fix

### Data model: one struct per batch, not scattered fields

A rolling batcher needs a separate record for each batch. Each batch
needs its own slice, deadline timer, and "already fired" flag. Then one
batch can fire while the next opens. You do not need to reset shared
fields under the new batch.

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

### Add: open or join a batch, fire on count, reject after close

```go {12,17,37}
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

`MaxWait <= 0` means there is no deadline. The collector fires by count
only. This is a useful default. It avoids an accidental instant fire on
the first request.

### detach: the one gate shared by all three triggers

```go {6,9}
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

Three triggers can fire a batch: the count in `Add`, the deadline timer,
and `Close`. The first one to call `detach(b)` sees `b.fired == false`.
Every other trigger sees `true`. This is a check-and-set step under one
lock. Use this pattern when more than one trigger can fire the same
action. The `c.batch == b` check protects a newer batch. A stale trigger
for an old batch can arrive after that newer batch opens.

`fn` runs **outside** the lock in its own goroutine. So `Add` does not
wait for a slow `fn` call. The Collector keeps rolling. A new batch can
open as soon as the old one fires. Callers filling the next batch do not
wait for the previous batch's `fn`. Holding the lock during `fn` would
delay every future `Add`.

### Why `Timer.Stop()` alone does not close the race

The count path calls `b.timer.Stop()` when it detaches a batch. The
`Timer.Stop` docs cover timers made with `AfterFunc(d, f)`. If
`t.Stop()` returns `false`, function `f` may already be running.
`Stop` does not rule that out.

That is why `detach` uses `b.fired` as the real gate. The return value
from `Stop()` is not enough. `Stop()` may run just before the timer
fires. The deadline goroutine may already wait on `c.mu.Lock()` in
`onDeadline`. It is about to call `detach` after the count path releases
the lock. `detach` sees `b.fired == true`. It does nothing. There is no
second `fn` call.

### The stale-timer-vs-newer-batch trap

A batch's deadline timer captures `b` in its closure. It does not use
whatever `c.batch` is when the timer fires. By the time a late callback
gets `c.mu`, the Collector may have opened newer batches. The
`if c.batch == b` check prevents a stale timer from touching an
unrelated batch.

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

Without `c.batch == b`, a stale callback could set `c.batch = nil`.
That would clear batch C's requests. It could also fire batch C with
batch A's request slice.

### Close: stop, flush, wait — bounded by ctx

```go {3,7,24}
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

Three steps happen in order. This follows the contract of
`net/http.Server.Shutdown`. First, `closed = true` stops new `Add` calls
from joining an old batch. Second, the current batch is detached and
fired. A partial batch still gets one real `fn` call. Third,
`inflight.Wait()` runs against `ctx.Done()`. `Close` stops waiting when
`ctx` expires. It does **not** cancel the batch. The batch keeps running
in the background. This matches a slow in-flight HTTP handler during
`Shutdown`.

`Close` is safe to call twice or concurrently with itself. Only one
batch can be open at a time. `detach`'s `b.fired` check means only the
first trigger fires it. Every other concurrent `Close` waits on the
same `inflight` WaitGroup.

## The trap that only shows up under `-race`: `wg.Add` after `Unlock`

A tempting version of `detach` keeps bookkeeping under the lock. The
lock can cover `b.fired = true` and clearing `c.batch`. The code moves
`c.inflight.Add(1)` into `startExecute`, next to the matching
`inflight.Done()`:

```go {2}
func (c *Collector) startExecute(b *batch) {
	c.inflight.Add(1) // BUG: moved out from under c.mu
	go func() {
		defer c.inflight.Done()
		c.executeBatch(b)
	}()
}
```

This looks harmless. `Add` and `Done` still pair for this batch. But it
breaks `Close`'s ordering guarantee. The `sync.WaitGroup` docs say a
positive `Add` must happen before a `Wait` that could see zero. If
`inflight.Add(1)` is outside the lock, another goroutine's `Close` has
no ordering with it. `Close` can get `c.mu` and see `c.batch == nil`.
The firing goroutine already cleared it. `Close` unlocks and starts
`inflight.Wait()` before `Add(1)` runs.

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

**Verified**: I forced this race with many concurrent `Add` calls and a
concurrent `Close`. Repeated `-race` runs catch it as
`sync.WaitGroup` misuse. It is not a hang or a wrong value. `-race`
reports a race on an internal WaitGroup field:

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

It reproduced about once in 100 runs with `-count=100 -race`. It can
pass a casual `go test -race` run and still be wrong.
`TestCollectorCloseConcurrentWithAdd` exists to catch it. The fix is to
keep `c.inflight.Add(1)` inside `detach`, under `c.mu`. Then `Add(1)`
happens before any `Close` critical section that can reach `Wait()`.
The mutex orders the two.

## A short `MaxWait` can split one intended batch into several

An early version of
`TestCollectorNeverDoubleFiresWhenCountAndWaitRace` used `MaxWait` of
1ms. Several goroutines raced to fill one batch. The test asserted that
`fn` ran exactly once. It failed often. The cause was not a double
fire. A 1ms deadline can be shorter than the time several goroutines
need to get scheduled. The first request's batch can fire by itself.
The next request then opens a separate batch. Two single-request
batches are valid. The test assumed all requests would share one batch.
That assumption was wrong for the timing.

Replace the exact-one-call check with a check that a real double fire
would fail. Add the number of requests processed across all `fn` calls.
Check that it equals the number submitted. A double fire counts one
request's batch twice. A valid split into small batches still processes
each request once. This check does not care how many batches the race
creates.

## Contrast with 35 (singleflight)

[35](../35-singleflight) says never hold the mutex during `fn`.
Unrelated keys must not wait for each other. This Collector follows the
same rule. `fn` runs unlocked in its own goroutine. Callers for a new
batch are unrelated work. They should not wait behind the previous
batch's `fn`. The shared principle is this. Hold the lock during a slow
call only when every blocked caller waits for that same call. Never
hold it when unrelated work waits.

## Alternative: one owner goroutine instead of a lock

The mutex design needs a `fired` flag. It also needs `WaitGroup` updates
under the lock. Three goroutines can try to fire one batch. The callers
are the count path in `Add`, the timer goroutine, and `Close`. The
count path is the caller that reaches `MaxBatchSize`.
[19](../19-actor-model)'s actor approach also applies. Give one
long-lived goroutine ownership of the batch. Send every trigger as a
channel message. A new request, the deadline, and `Close` all use a
message instead of a lock.

```go
type request struct {
	value int
	reply chan Result
}

type Collector struct {
	cfg  Config
	fn   BatchFunc
	reqs chan request
	stop chan chan error // Close sends its own reply-channel in here
	done chan struct{}   // closed once the owner goroutine has exited
}

func NewCollector(cfg Config, fn BatchFunc) *Collector {
	c := &Collector{
		cfg:  cfg,
		fn:   fn,
		reqs: make(chan request),
		stop: make(chan chan error),
		done: make(chan struct{}),
	}
	go c.run()
	return c
}

func (c *Collector) Add(value int) <-chan Result {
	reply := make(chan Result, 1)
	select {
	case c.reqs <- request{value, reply}:
	case <-c.done:
		reply <- Result{Err: ErrCollectorClosed}
	}
	return reply
}

// run is the sole owner of the current batch. Every trigger this
// exercise cares about - a request that fills the batch, the batch's
// own deadline, and Close - is just another case in this one select,
// so only ever one goroutine can decide "fire now".
func (c *Collector) run() {
	defer close(c.done)

	var current []request
	var deadline <-chan time.Time
	var inflight sync.WaitGroup

	fire := func() {
		if len(current) == 0 {
			return
		}
		batch := current
		current, deadline = nil, nil
		inflight.Add(1) // same goroutine that will Wait() - no race to order
		go func() { defer inflight.Done(); c.runBatch(batch) }()
	}

	for {
		select {
		case req := <-c.reqs:
			current = append(current, req)
			if len(current) == 1 && c.cfg.MaxWait > 0 {
				deadline = time.After(c.cfg.MaxWait)
			}
			if len(current) >= c.cfg.MaxBatchSize {
				fire()
			}
		case <-deadline:
			fire()
		case reply := <-c.stop:
			fire()
			go func() { inflight.Wait(); reply <- nil }()
			return
		}
	}
}
```

Both headline traps disappear by design. There is no `fired` flag
because only `run` fires. There is no WaitGroup ordering race.
`inflight.Add(1)` and the batch check both run in `run`, in program
order.

This is not no synchronization. The synchronization moved, and it has
costs:

- `Add` must still fail fast after `Close`. Sending on `c.reqs` can
  block forever after `run` exits. `Add` must race that send against
  `c.done`. This is the channel version of `if c.closed`.
- The deadline timer must start only when the batch goes from empty to
  non-empty. It must clear on every fire. Set `deadline = nil` to
  disable the `<-deadline` case. Otherwise, a stale channel can fire
  into a new batch. This is the same stale-timer hazard as the mutex
  version.
- `Close` must still handle `ctx`. It limits the wait, not `fn`'s
  runtime. This was omitted above for brevity. The shape is the same:
  race `inflight.Wait()` against `ctx.Done()`. Here the `c.stop` case
  triggers it.
- One extra goroutine, `run`, lives for the Collector's lifetime.
  `Close` must not return until `run` has exited. Otherwise, this repo's
  no-goroutine-leak rule fails.

Neither design is clearly simpler. The mutex version uses one
flag-and-lock rule in three call sites. The channel version uses one
`select` loop. Its main risk moves from `fired` under the lock to timer
arm and disarm. Choose the design your team can review more reliably.
There is no single "real concurrent Go way."

## Key takeaways

- A rolling batcher needs a record per batch. A struct is safer than
  scattered counters. Then firing one batch cannot corrupt the next
  one that opens.
- Count, deadline, and close can all try to fire the same batch. They
  need one shared gate. A `fired` flag set under one lock is one option.
  Do not use three checks that can all succeed.
- `Timer.Stop()` does not prove the timer function is not running or
  about to run. Check state under the same lock. Do not rely on the
  return from `Stop()`.
- `sync.WaitGroup.Add` must happen before any `Wait` that could see
  zero. If `Add` and the start decision cross an unlock, move `Add`
  inside the lock.
- Bound `Close` with `context.Context`. The
  `net/http.Server.Shutdown` model defines a clear contract. Wait for
  graceful shutdown, but not forever. An unbounded `Wait()` gives the
  caller no way to stop.
