# Flash-Sale Inventory: Lock-Free Stock Claims with CompareAndSwap — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `38-flash-sale-inventory/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

The starting point is a `Store` that reads and writes `stock` with no synchronization at all:

```go
func (s *Store) Claim() bool {
	if s.stock > 0 {
		s.stock--
		return true
	}
	return false
}
```

`Claim` must be safe for any number of goroutines to call concurrently, must never oversell (successful claims can't exceed the starting stock) and must never lose a claim either (as many callers as there's stock left must succeed) - all **without a lock**, since `Claim` runs on every incoming request.

## Why the naive version is wrong

Reading `s.stock` and writing it back are two separate, unsynchronized steps. Two goroutines can both read `stock` as `1`, both see `stock > 0`, and both decrement - selling the same last unit twice. Verified against the naive `main.go`, `TestClaimNeverOversellsOrLoses` fails on 10/10 consecutive runs, **even without `-race`**, once there's enough concurrent pressure (4000 goroutines racing for 200 units, repeated over 5 rounds):

```
--- FAIL: TestClaimNeverOversellsOrLoses
    check_test.go:83: round 0: 205 Claim call(s) succeeded out of 4000 concurrent attempts
        against a stock of 200 - want exactly 200 successes, no more (oversold) and no fewer
        (lost claims)
FAIL
```

This is one of the most reliably reproducible concurrency bugs there is - the classic unsynchronized check-then-decrement race, the same shape as a `counter++` race. `go test -race` catches it even more directly, flagging the raw unsynchronized read/write on `s.stock` as a data race outright, independent of whether that particular run happened to oversell.

## The fix: a `CompareAndSwap` retry loop

```go
import "sync/atomic"

type Store struct {
	stock int64
}

func NewStore(stock int) *Store {
	return &Store{stock: int64(stock)}
}

func (s *Store) Claim() bool {
	for {
		cur := atomic.LoadInt64(&s.stock)
		if cur <= 0 {
			return false
		}
		if atomic.CompareAndSwapInt64(&s.stock, cur, cur-1) {
			return true
		}
		// s.stock changed under us since cur was read - retry with a fresh value.
	}
}

func (s *Store) Remaining() int64 {
	return atomic.LoadInt64(&s.stock)
}
```

The mechanism - the general "optimistic retry" idiom every `CompareAndSwap` loop follows:

1. **Read** the current value (`cur := atomic.LoadInt64(&s.stock)`).
2. **Check the precondition and compute the new value** from what was read (`cur <= 0` → sold out; otherwise the new value is `cur-1`).
3. **Install it, but only if nothing else changed the value since step 1** (`atomic.CompareAndSwapInt64(&s.stock, cur, cur-1)` - this compares the live value against `cur` and swaps in `cur-1` in one atomic step; it fails and returns `false` if some other goroutine already moved `stock` away from `cur`).
4. **Retry from step 1 if the swap failed.** Some other goroutine's successful claim is exactly why `cur` is now stale - looping back picks up its fresh value and tries again.

No caller ever blocks on a lock; contention just costs some callers an extra loop iteration or two, which is far cheaper than serializing every request behind one mutex.

Verified clean, repeatedly:

```
go test -count=20 .        # 20/20 clean
go test -race -count=20 .  # 20/20 clean
```

## Approach 2: `AddInt64` with a compensating undo

A narrower fix works too, and is worth knowing about specifically to see *why* it doesn't generalize:

```go
func (s *Store) Claim() bool {
	if atomic.AddInt64(&s.stock, -1) >= 0 {
		return true
	}
	atomic.AddInt64(&s.stock, 1) // undo the decrement we shouldn't have made
	return false
}
```

This is correct: `AddInt64` is itself atomic, so the optimistic decrement-then-check never races with another `Claim`'s decrement-then-check. If the decrement takes `stock` below zero, the call adds `1` back to undo its own overshoot, and returns `false`. It passes every test in this exercise, including `TestClaimNeverOversellsOrLoses` under `-race`.

The catch is `TestMainUsesCompareAndSwap`, which this approach fails on purpose: it never calls `CompareAndSwap*`. That's not an arbitrary restriction - it's the whole point of the exercise. This trick works *only* because "decrement by one" has a trivial inverse ("add one back"). The moment an update isn't a fixed additive delta - tracking a running maximum, applying an update only if a version number hasn't changed, merging in a new computed value that depends on the old one in a non-reversible way - there's no compensating operation to undo a wrong guess with. `CompareAndSwap`'s "read, compute, install-only-if-unchanged, retry" loop keeps working for all of those; the undo-with-`Add` trick is a dead end specific to this one operation.

## A note on the static checks

`check_test.go` enforces both sides of the lesson with AST inspection rather than behavioral tests, since a mutex-guarded `Store` would pass every functional test above just as well as a lock-free one:

- `TestMainDoesNotUseLocks` walks every top-level declaration except `main()` itself (so `main()`'s own demo is free to use `sync.WaitGroup`, or even a `sync.Mutex` of its own purely to collect printed results) and fails if `sync.Mutex`, `sync.RWMutex`, or `sync.Map` appears anywhere else - catching a lock hidden as a `Store` field just as well as one hidden behind a package-level variable.
- `TestMainUsesCompareAndSwap` requires `sync/atomic` to be imported and a `CompareAndSwap*` call to appear somewhere in `main.go`, closing off the `AddInt64`-with-undo shortcut above so the exercise can't be solved without actually practicing the idiom it's named for.
