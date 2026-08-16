# Dining Philosophers: Deadlock Avoidance — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `21-dining-philosophers/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

Five philosophers sit around a round table with one fork between each
adjacent pair (so `numPhilosophers` forks total). To eat, a
philosopher must hold both their left and right fork at once; when
done, both go back down so neighbors can use them. `Dine` is supposed
to let every philosopher finish `mealsToEat` meals without the table
ever grinding to a halt.

The given implementation always acquires forks in the same order —
left first, then right, for every philosopher:

```go
func (p *Philosopher) Dine(wg *sync.WaitGroup, mealsEaten *int32) {
	defer wg.Done()

	for i := 0; i < p.mealsToEat; i++ {
		p.leftFork.mu.Lock()
		// A brief pause while "reaching" for the right fork. In
		// practice this is exactly how the classic deadlock actually
		// manifests: it gives every other philosopher's goroutine
		// time to also grab their own left fork before any of them
		// moves on to try for their right one, so the circular wait
		// forms reliably instead of only occasionally.
		time.Sleep(time.Millisecond)
		p.rightFork.mu.Lock()

		// eat
		time.Sleep(10 * time.Microsecond)
		atomic.AddInt32(mealsEaten, 1)

		p.rightFork.mu.Unlock()
		p.leftFork.mu.Unlock()
	}
}
```

with each philosopher `i` assigned `left = forks[i]`,
`right = forks[(i+1)%numPhilosophers]`.

## Why the naive version is wrong

This is the textbook circular-wait deadlock, not a slowness or
correctness bug: if all `numPhilosophers` goroutines start at roughly
the same time, every one of them successfully grabs its left fork
before any of them gets around to trying for its right fork (the
`time.Sleep(time.Millisecond)` in between makes this reliable rather
than occasional — it widens the window for every goroutine to get its
left fork before racing for its right one). At that point philosopher
`i` holds fork `i` and blocks forever on fork `(i+1)%numPhilosophers`,
which is held by philosopher `i+1`, who is in turn blocked on fork
`(i+2)%numPhilosophers` — a complete cycle where nobody can ever make
progress again. Every philosopher goroutine is now durably parked on a
`sync.Mutex.Lock()` call that will never return, and `wg.Wait()` in
`Dine` never returns either.

**Why `check_test.go` deliberately avoids `testing/synctest` here.**
`synctest.Test` detects exactly the condition "every goroutine in the
bubble is durably blocked" — but its reaction to that condition is to
panic with `"deadlock: ..."`, taking down the whole test binary, not
just the one test. That's the right tool in exercise 20, where the
naive bug is mere *slowness* (goroutines finish, just sequentially) —
`synctest`'s fake clock can fast-forward through that safely. It's the
wrong tool here, where the naive bug is a genuine, permanent deadlock:
a `synctest` bubble around `Dine(5, 3)` would panic-crash the test
binary the moment every philosopher goroutine parks on a mutex, which
would fail every test in the file (including
`TestDineWithVaryingTableSizes`), not just report the one deadlocking
case cleanly.

Instead, `check_test.go` runs `Dine` on a plain goroutine and races it
against a real-clock `time.After(3 * time.Second)` via `select`. If
`Dine` deadlocks, that goroutine simply never sends on `done` and is
leaked forever — which is harmless, because `go test` doesn't wait
around for leaked goroutines; it moves on the instant the test function
returns via `t.Fatalf`. That produces a clean, fast, readable failure
message instead of a hang or a crash:

```
--- FAIL: TestDineCompletesWithoutDeadlock (3.00s)
    check_test.go:72: deadlock: dinner did not complete within 3s - philosophers
    are stuck waiting on forks that will never be released (every philosopher
    grabbed their left fork first, so everyone is waiting on their neighbor's
    right fork)
```

confirmed against the naive version in the checked-in scaffold: it
fails via this exact 3-second `t.Fatal` timeout, not a panic or a hang
of the test run itself.

**Why `mealsToEat` is `10_000`, not a "natural" handful of meals.**
The naive implementation's deadlock is only *reliable* because of the
artificial `time.Sleep(time.Millisecond)` pause between grabbing the
left and right fork above — that pause is what forces every
philosopher into lockstep on the very first meal. A solver could
notice that pause, delete it, and leave the fork-acquisition order
completely unfixed: with the pause gone, the collision window shrinks
to whatever's left of ordinary scheduling noise, and at a low meal
count (the original `mealsToEat = 10`) that still-broken version can
slip past the test on a lucky run — confirmed: at `mealsToEat = 10`,
the pause-deleted, still-broken version passes every one of 10
back-to-back runs. Looping `mealsToEat` up to `10_000` instead gives
that same still-broken implementation enough independent chances to
collide that it deadlocks reliably anyway — confirmed: 10/10 runs
timed out at the 3-second mark with the pause deleted and the fork
order left broken — while a genuine fix, which never depends on timing
luck in the first place, still finishes in well under a second (see
"Verified" below). This is also why the naive scaffold's own "eat"
delay is a tiny `10 * time.Microsecond` rather than a full
millisecond: at `10_000` meals per philosopher, a millisecond-scale eat
delay would make even a *correct* fix take tens of seconds just to
finish simulating that many meals.

## Approach 1: Resource ordering (always lock the lower-indexed fork first)

The simplest, most idiomatic fix: instead of always locking "left,
then right," each philosopher locks whichever of its two forks has the
**lower index** first, regardless of which one is nominally its left
or right fork. The artificial "reaching" pause was only ever there to
make the naive bug reproduce reliably — a genuine fix has no reason to
keep it:

```go
func (p *Philosopher) Dine(wg *sync.WaitGroup, mealsEaten *int32) {
	defer wg.Done()

	first, second := p.leftFork, p.rightFork
	if second.index < first.index {
		first, second = second, first
	}

	for i := 0; i < p.mealsToEat; i++ {
		first.mu.Lock()
		second.mu.Lock()

		// eat
		time.Sleep(10 * time.Microsecond)
		atomic.AddInt32(mealsEaten, 1)

		second.mu.Unlock()
		first.mu.Unlock()
	}
}
```

Why this eliminates the deadlock: circular wait requires every
philosopher in the cycle to be holding one fork while waiting on
*another philosopher's* fork, forming a closed loop where the acquisition
order disagrees somewhere around the table. Once every philosopher
agrees on a single global order — lowest index first, always — that
disagreement can't arise. Concretely, in a 5-philosopher table, the
philosopher sitting between forks 4 and 0 now locks fork 0 first (not
fork 4), same as the philosopher between forks 0 and 1. Whichever of
those two philosophers gets to fork 0 first is guaranteed to be able to
also acquire its second fork and complete a full meal (nothing else
is contending for the *other* fork it needs before it does), which
breaks the cycle: there's always at least one philosopher who isn't
stuck waiting on a neighbor who is itself stuck waiting on them.

Verified in the checked-in scaffold: `go test -race -count=20` passed
cleanly — `TestDineCompletesWithoutDeadlock` consistently in
~0.57-0.61s (well inside the 3-second timeout) and
`TestDineWithVaryingTableSizes` across `numPhilosophers` = 2, 5, 8 all
passing instantly, with no flakiness across twenty repeated runs and
the race detector silent throughout (the only shared state touched is
each `Fork`'s own `sync.Mutex` and `mealsEaten` via
`atomic.AddInt32`).

## Approach 2: Arbitrator / counting semaphore

A genuinely different mechanism, and the other classic textbook
solution: instead of changing *how* forks are acquired, limit *how many
philosophers may attempt to pick up forks at once* to
`numPhilosophers - 1`, via a counting semaphore (a buffered channel
used as a permit pool). Fork acquisition order is left unchanged —
still left-then-right:

```go
func (p *Philosopher) Dine(wg *sync.WaitGroup, mealsEaten *int32, arbitrator chan struct{}) {
	defer wg.Done()

	for i := 0; i < p.mealsToEat; i++ {
		arbitrator <- struct{}{} // request permission to sit down and pick up forks

		p.leftFork.mu.Lock()
		p.rightFork.mu.Lock()

		// eat
		time.Sleep(10 * time.Microsecond)
		atomic.AddInt32(mealsEaten, 1)

		p.rightFork.mu.Unlock()
		p.leftFork.mu.Unlock()

		<-arbitrator // done with forks, let someone else in
	}
}

func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32) {
	forks := make([]*Fork, numPhilosophers)
	for i := range forks {
		forks[i] = &Fork{index: i}
	}

	arbitrator := make(chan struct{}, numPhilosophers-1)

	var wg sync.WaitGroup
	var mealsEaten int32
	for i := 0; i < numPhilosophers; i++ {
		left := forks[i]
		right := forks[(i+1)%numPhilosophers]
		p := &Philosopher{id: i, leftFork: left, rightFork: right, mealsToEat: mealsToEat}
		wg.Add(1)
		go p.Dine(&wg, &mealsEaten, arbitrator)
	}
	wg.Wait()

	return mealsEaten
}
```

Note this changes `Philosopher.Dine`'s signature (it now takes the
`arbitrator` channel) — an equally valid alternative is to store the
arbitrator on the `Philosopher` struct instead and leave the method
signature untouched. Either way, the *outer* signature the exercise
constrains, `func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)`,
is unchanged, so it's still a drop-in replacement.

**Be precise about the mechanism.** This does *not* eliminate
hold-and-wait — an admitted philosopher still grabs its left fork and
then blocks holding it while waiting for its right fork, exactly as in
the naive version. What it does instead is bound contention: with
`numPhilosophers` forks but only `numPhilosophers - 1` philosophers ever
allowed past the arbitrator at once, at least one seat at the table is
always empty. That guarantees the wait-for graph can never close into a
full cycle around all `numPhilosophers` forks — with one philosopher
permanently excluded, there's always at least one admitted philosopher
whose desired second fork isn't held by another *admitted* philosopher
who is itself stuck waiting, so someone can always complete both
acquisitions, eat, and release, which lets the next-most-blocked
philosopher through in turn.

(This exercise's fork assignment, `left = forks[i]`,
`right = forks[(i+1) % numPhilosophers]`, is only meaningful for
`numPhilosophers >= 2` — at `numPhilosophers == 1`, `left` and `right`
resolve to the same fork, so any approach, naive or fixed, would
self-deadlock locking one mutex twice. That's a degenerate case outside
what the round-table model represents, not something either fix is
expected to handle.)

Verified in the checked-in scaffold: `go test -race -count=3` passed
cleanly — `TestDineCompletesWithoutDeadlock` in ~0.82-0.87s and
`TestDineWithVaryingTableSizes` across `numPhilosophers` = 2, 5, 8 all
passing quickly, no flakiness across three repeated runs, race detector
silent throughout. (Slightly slower than Approach 1 because the
arbitrator channel adds a send/receive per meal on top of the mutex
pair, and `numPhilosophers - 1` admitted philosophers still contend for
forks among themselves.)

## Approach 1 vs. Approach 2

Both break the same underlying cycle, through a different one of the
four necessary conditions for deadlock:

- **Approach 1 (resource ordering)** attacks **circular wait**
  directly: it makes it structurally impossible for the acquisition
  graph to form a cycle, by forcing every philosopher to agree on one
  global lock order.
- **Approach 2 (arbitrator)** doesn't touch acquisition order at all;
  it attacks the *scale* of hold-and-wait by guaranteeing the number of
  simultaneously-contending philosophers is always strictly less than
  the number of forks, so a full cycle spanning every fork can never
  form in the first place.

Resource ordering is generally preferred in practice: it needs no extra
synchronization primitive, scales to any number of resources per
task (not just two), and doesn't leave a philosopher waiting on a
semaphore permit that's unrelated to the forks it actually needs. The
arbitrator/semaphore approach is the more general "limit concurrent
resource-holders" pattern, useful when resources don't have a natural
total order to sort by, or when you want a tunable admission-control
knob independent of resource identity.

## Key takeaways

- The naive bug here is a genuine, permanent deadlock (circular wait),
  not slowness — that's why `check_test.go` uses a real-clock goroutine
  + `time.After` timeout instead of `testing/synctest`: `synctest`
  would detect the same "everyone's durably blocked" condition but
  react by panicking the whole test binary, rather than failing just
  the one test cleanly. Reach for `synctest` when the naive code merely
  runs slowly (exercise 20); reach for a real-clock timeout-and-leak
  pattern when the naive code can genuinely hang forever.
- `mealsToEat` is cranked up to `10_000` specifically to close a cheat
  path: deleting the naive scaffold's artificial "reaching" pause
  without fixing fork order shrinks the deadlock's collision window,
  but doesn't eliminate the bug — enough repeated attempts still
  collide reliably (10/10 runs), while a genuine fix's runtime is
  unaffected by meal count in the first place.
- Resource ordering (Approach 1) breaks the deadlock by eliminating
  circular wait: every philosopher agreeing on one global lock order
  makes a closed wait-cycle structurally impossible.
- The arbitrator/semaphore (Approach 2) breaks the deadlock differently:
  it doesn't touch lock order at all, it bounds how many philosophers
  can be mid-acquisition at once to `numPhilosophers - 1`, so a cycle
  spanning every fork can never form — it does *not* eliminate
  hold-and-wait at the individual-philosopher level.
- Both fixes preserve the `Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)`
  signature and touch shared state only through each `Fork`'s own
  mutex plus `atomic.AddInt32` on the shared counter, so both are
  race-free under `-race` with no additional locking needed.
