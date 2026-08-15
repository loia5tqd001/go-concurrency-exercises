# Flash-Sale Inventory: Lock-Free Stock Claims with CompareAndSwap — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

`Claim` reads and writes `stock` with no synchronization:

```go
func (s *Store) Claim() bool {
	if s.stock > 0 {
		s.stock--
		return true
	}
	return false
}
```

```
stock = 1
goroutine A: reads stock (1) ──▶ stock>0 ──▶ stock-- ──▶ true
goroutine B: reads stock (1) ──▶ stock>0 ──▶ stock-- ──▶ true
                                    ↑ same last unit, sold twice
```

**Verified**: `TestClaimNeverOversellsOrLoses` fails 10/10 runs, even
without `-race`, once there's enough concurrent pressure (4000
goroutines racing for 200 units, 5 rounds):

```
--- FAIL: TestClaimNeverOversellsOrLoses
    round 0: 205 Claim call(s) succeeded out of 4000 concurrent attempts
    against a stock of 200 - want exactly 200 successes, no more
    (oversold) and no fewer (lost claims)
```

This is one of the most reliably reproducible concurrency bugs there
is — the classic unsynchronized check-then-decrement, same shape as a
`counter++` race. `go test -race` flags the raw unsynchronized
read/write outright, independent of whether a given run oversold.

## The fix: a `CompareAndSwap` retry loop

```go
type Store struct {
	stock int64
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

The optimistic-retry idiom every `CompareAndSwap` loop follows:

```
1. READ    cur := Load(&stock)
2. CHECK   cur <= 0 ?  → sold out, return false
3. COMPUTE new value = cur - 1
4. INSTALL CAS(&stock, cur, cur-1)
      succeeds only if stock still == cur  → done, return true
      fails if someone else already moved it → back to step 1 with a fresh read
```

No caller ever blocks on a lock; contention just costs some callers an
extra loop iteration, far cheaper than serializing every request
behind one mutex.

**Verified** clean, repeatedly: `go test -count=20 .` and
`go test -race -count=20 .`, both 20/20.

## Approach 2: `AddInt64` with a compensating undo

A narrower fix works too, worth knowing about specifically to see why
it doesn't generalize:

```go
func (s *Store) Claim() bool {
	if atomic.AddInt64(&s.stock, -1) >= 0 {
		return true
	}
	atomic.AddInt64(&s.stock, 1) // undo the decrement we shouldn't have made
	return false
}
```

Correct: `AddInt64` is itself atomic, so the decrement-then-check never
races another `Claim`'s. Passes every functional test, including
`TestClaimNeverOversellsOrLoses` under `-race`.

The catch: `TestMainUsesCompareAndSwap` fails this on purpose — it
never calls `CompareAndSwap*`. Not arbitrary: this trick works *only*
because "decrement by one" has a trivial inverse. The moment an update
isn't a fixed additive delta — a running maximum, a version-gated
write, a computed merge — there's no compensating operation to undo a
wrong guess with. The undo-with-`Add` trick is a dead end specific to
this one operation; `CompareAndSwap`'s loop keeps working everywhere.

## A note on the static checks

`check_test.go` enforces both sides of the lesson with AST inspection,
not behavior, since a mutex-guarded `Store` would pass every
functional test just as well as a lock-free one:

- `TestMainDoesNotUseLocks` walks every top-level declaration except
  `main()` (free to use `sync.WaitGroup`/`sync.Mutex` for its own
  demo bookkeeping) and fails if `sync.Mutex`, `sync.RWMutex`, or
  `sync.Map` appears anywhere else.
- `TestMainUsesCompareAndSwap` requires `sync/atomic` imported and a
  `CompareAndSwap*` call somewhere in `main.go`, closing off the
  `AddInt64`-with-undo shortcut so the exercise can't be solved
  without practicing the idiom it's named for.

## Key takeaways

- Check-then-write on a shared variable is a race even when each step
  looks atomic in isolation — the gap between them is where two
  goroutines both "win."
- `CompareAndSwap`'s read → compute → install-if-unchanged → retry loop
  is the general lock-free update pattern; `AddInt64`-with-undo is a
  narrow trick that only works when the operation is its own inverse.
