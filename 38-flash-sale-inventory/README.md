# Flash-Sale Inventory: Lock-Free Stock Claims with CompareAndSwap

`Store` sells a limited number of units of a flash-sale item. Any
number of unrelated goroutines — one per "buy" request — call `Claim`
concurrently, each trying to grab exactly one unit. Right now `Claim`
reads and writes `stock` with no synchronization at all:

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
goroutine A: reads stock (1) ──▶ stock > 0 ──▶ stock-- ──▶ return true
goroutine B: reads stock (1) ──▶ stock > 0 ──▶ stock-- ──▶ return true   ← same last unit, sold twice
```

Read-then-write are two separate steps. If two goroutines both read
`stock` as `1` before either writes, both see `stock > 0`, both
decrement, both report success — selling the same last unit twice. The
opposite failure shows up too under enough pressure: claims go
missing, fewer buyers succeed than the stock allows. This is the
ordinary way a flash-sale endpoint gets hammered the moment it goes
live.

## Your task

Fix `Store` so that:

- `Claim` is safe for any number of concurrent goroutines and **never
  oversells**: successful claims can never exceed starting stock.
- `Claim` **never loses a claim**: if `N` units remain, up to `N` of
  the concurrently-racing callers must succeed.
- `Remaining` always reflects exactly how many units are left.

**No `sync.Mutex`, `sync.RWMutex`, or any other lock** — `Claim` is a
hot path on every request, and serializing every caller behind one
lock is exactly the cost this exercise asks you to avoid. Use
`sync/atomic`'s `CompareAndSwap` idiom instead:

```
loop:
  cur := Load(&stock)              read
  if cur <= 0: return false        check
  ok := CAS(&stock, cur, cur-1)    install — but ONLY if nothing changed stock since cur was read
  if ok: return true
  else: retry from the top         someone else's claim beat us to it — try again with a fresh read
```

Signatures stay the same:

```go
func NewStore(stock int) *Store
func (s *Store) Claim() bool
func (s *Store) Remaining() int64
```

## Why `atomic.AddInt64` alone isn't the whole idiom

Tempting to sidestep `CompareAndSwap` entirely:

```go
func (s *Store) Claim() bool {
	if atomic.AddInt64(&s.stock, -1) >= 0 {
		return true
	}
	atomic.AddInt64(&s.stock, 1) // undo the decrement we shouldn't have made
	return false
}
```

This works *here*, because subtracting one has a trivial inverse —
adding one back. That reversibility is special to "decrement by a
fixed amount," not general. The moment an update isn't undoable by
plain arithmetic — "keep whichever is larger," "only apply this write
if a version number hasn't changed" — there's no `+1` that puts things
back. `CompareAndSwap`'s read-compute-install-if-unchanged-retry loop
generalizes to all of that; this exercise is a good first case to
practice it on because it's simple enough to reason about by hand.

## Test your solution

```
go test
go test --race
```
