# Dining philosophers: avoid deadlock

> **Spoiler warning.** This file has full solutions for `21-dining-philosophers/`. Try the exercise first. Come back if you get stuck.

## The problem

Five philosophers sit around a round table. There is one fork between each pair, so `numPhilosophers` forks exist in total.

To eat, a philosopher must hold the left and right fork at the same time. Then both forks return to the table.

`Dine` must let every philosopher finish `mealsToEat` meals. The table must not stop forever.

The starter always takes the left fork first, then the right fork:

```go {5,13}
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

Philosopher `i` gets `left = forks[i]` and `right = forks[(i+1)%numPhilosophers]`.

## Why the naive version is wrong

This is the classic circular-wait deadlock. It is not slow code and not a wrong answer.

All goroutines start together. Each goroutine can take its left fork before any tries for its right fork.

`time.Sleep(time.Millisecond)` widens that window. The deadlock then happens every time, not by chance.

Philosopher `i` holds fork `i`. It waits for fork `(i+1)%numPhilosophers`, which philosopher `i+1` holds.

Philosopher `i+1` waits for fork `(i+2)%numPhilosophers`, and the cycle continues. Nobody can move.

Every goroutine waits in a `sync.Mutex.Lock()` call forever. `wg.Wait()` in `Dine` never returns.

**Why `check_test.go` avoids `testing/synctest` here.** `synctest.Test` can detect a bubble where every goroutine is blocked.

It then panics with `"deadlock: ..."`. That panic kills the whole test binary, not one test.

This works in exercise 20, where the bug is only slowness. The fake clock can move past it safely.

It does not work for a real deadlock. `Dine(5, 3)` would panic and fail every test in the file.

`check_test.go` runs `Dine` in a plain goroutine. It races that goroutine with `time.After(3 * time.Second)` through `select`.

If `Dine` deadlocks, the goroutine never sends on `done`. It leaks.

`go test` does not wait for leaked goroutines. The test calls `t.Fatalf` and returns. The result is a clear failure, not a hang or crash:

```
--- FAIL: TestDineCompletesWithoutDeadlock (3.00s)
    check_test.go:72: deadlock: dinner did not complete within 3s - philosophers
    are stuck waiting on forks that will never be released (every philosopher
    grabbed their left fork first, so everyone is waiting on their neighbor's
    right fork)
```

The naive scaffold fails with this 3-second `t.Fatal` timeout. It does not panic or hang the test run.

**Why `mealsToEat` is `10_000`.** The deadlock is reliable because the starter pauses between forks.

That pause puts every philosopher into lockstep on the first meal. A solver could delete the pause and keep the broken fork order.

With no pause, ordinary scheduling hides the collision. At `mealsToEat = 10`, the broken version passed 10 of 10 runs.

At `10_000` meals, the broken version gets enough chances to collide. It timed out in 10 of 10 runs.

A correct fix does not depend on timing. It still finishes in under a second.

The starter's eat delay is only `10 * time.Microsecond`. A millisecond eat delay would make 10,000 meals take too long, even with a fix.

## Approach 1: Resource ordering (always lock the lower-indexed fork first)

This is the simplest fix. Each philosopher locks the lower-indexed fork first.

It does not matter whether that fork is on the left or right. The pause was only there to make the bug repeat. A real fix removes it.

```go {5,6}
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

Circular wait needs a closed loop. Each philosopher holds one fork and waits for another philosopher's fork.

A global order removes that loop. Everyone takes the lowest index first.

At a table of 5, the philosopher between forks 4 and 0 takes fork 0 first. The philosopher between forks 0 and 1 also takes fork 0 first.

One global order means the wait graph cannot form a cycle. At least one philosopher can always finish and release forks.

I tested this in the checked-in scaffold. `go test -race -count=20` passed with no flakes.

`TestDineCompletesWithoutDeadlock` took about 0.57 to 0.61 seconds each time. The timeout is 3 seconds.

`TestDineWithVaryingTableSizes` passed at once for `numPhilosophers` 2, 5, and 8. The race detector reported nothing.

The only shared state is each `Fork`'s `sync.Mutex` and `mealsEaten` through `atomic.AddInt32`.

## Approach 2: Arbitrator / counting semaphore

This is another classic solution. It does not change fork order. It limits how many philosophers may try to take forks at once.

A counting semaphore controls that limit. The code uses a buffered channel as a permit pool. It allows `numPhilosophers - 1` philosophers. Fork order stays left then right:

```go {5,17,27}
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

This changes the signature of `Philosopher.Dine` by adding the `arbitrator` channel.

You can also store the arbitrator on the `Philosopher` struct. Then the method signature stays the same.

The required outer signature, `func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)`, does not change. The version remains a drop-in replacement.

This does not remove hold-and-wait. A philosopher still takes the left fork and waits while holding it for the right fork.

The limit bounds contention. There are `numPhilosophers` forks, but only `numPhilosophers - 1` philosophers may pass the arbitrator.

At least one place at the table is always empty. The wait-for graph cannot form a full cycle around all forks.

One admitted philosopher can always get both forks. It eats and releases them. The next philosopher can then move.

The fork assignment needs `numPhilosophers >= 2`.

The code uses `right = forks[(i+1) % numPhilosophers]` and `left = forks[i]`.

At `numPhilosophers == 1`, `left` and `right` are the same fork. Every version would deadlock on the second lock.

That case is outside the round-table model. Neither fix handles it.

I tested this in the checked-in scaffold. `go test -race -count=3` passed with no flakes.

`TestDineCompletesWithoutDeadlock` took about 0.82 to 0.87 seconds. `TestDineWithVaryingTableSizes` passed quickly for 2, 5, and 8 philosophers.

It is slightly slower than Approach 1. The arbitrator sends and receives once per meal. Admitted philosophers still contend for forks.

## Approach 1 vs. Approach 2

Both break the cycle in different ways:

- Approach 1 changes resource order. It removes circular wait by giving every philosopher one global lock order.
- Approach 2 keeps acquisition order. It limits hold-and-wait by keeping the number of contenders below the number of forks.

Resource ordering is usually better. It needs no extra primitive and works with more than two resources.

It also does not make a philosopher wait for a permit unrelated to the forks.

The arbitrator is a general "limit concurrent holders" pattern. Use it when resources have no natural order or you need adjustable admission control.

## Key takeaways

- The naive bug is a real deadlock, not slowness. That is why `check_test.go` uses a real clock and `time.After`.
- `synctest` would panic the whole test binary instead of failing one test.
- Use `synctest` for slow code, as in exercise 20. Use a real timeout for code that can hang forever.
- `mealsToEat` is `10_000` to close a cheat path. Deleting the pause without fixing order only makes the bug less frequent.
- The broken version still timed out in 10 of 10 runs. A real fix does not depend on meal count for correctness.
- Resource ordering removes circular wait. One global lock order makes a cycle impossible.
- The arbitrator keeps lock order. It limits active philosophers to `numPhilosophers - 1`, so a full cycle cannot form.
- The arbitrator does not remove hold-and-wait for one philosopher.
- Both fixes keep the `Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)` signature.
- Both use each `Fork` mutex and `atomic.AddInt32`. Both are race-free under `-race` without more locking.
