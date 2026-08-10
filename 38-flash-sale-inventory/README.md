# Flash-Sale Inventory: Lock-Free Stock Claims with CompareAndSwap

Given is a `Store` selling a limited number of units of a flash-sale item. Any number of unrelated goroutines - one per incoming "buy" request - call `Claim` concurrently, each trying to grab exactly one unit for their buyer. Right now `Claim` reads and writes `stock` with no synchronization of any kind:

```go
func (s *Store) Claim() bool {
	if s.stock > 0 {
		s.stock--
		return true
	}
	return false
}
```

Reading `s.stock` and then writing it back are two separate steps. If two goroutines both read `stock` as `1` before either one writes, both see `stock > 0`, both decrement, and both report success - selling the same last unit twice. Run enough concurrent buyers against a small stock and the opposite failure shows up too: claims go missing, and fewer buyers succeed than the stock should allow. This isn't a rare corner case - it's the ordinary way a flash-sale endpoint gets hammered the moment it goes live.

Your task is to fix `Store` so that:

- `Claim` is safe to call concurrently, from any number of goroutines, and **never oversells**: the number of calls that return `true` can never exceed the stock the `Store` started with.
- `Claim` **never loses a claim** either: if `N` units of stock remain, up to `N` of the concurrently-racing callers must succeed - not fewer.
- `Remaining` always reflects exactly how many units are left.

This must be solved **without a `sync.Mutex`, `sync.RWMutex`, or any other lock** - `Claim` is a hot path called on every single request, so serializing every caller behind one lock is exactly the cost this exercise asks you to avoid. Use `sync/atomic` instead, and reach for its `CompareAndSwap` idiom: read the current stock, compute the value you'd like to write, and atomically install it **only if nothing else changed the stock in between** - retrying if something did.

The signatures must stay the same:

```go
func NewStore(stock int) *Store
func (s *Store) Claim() bool
func (s *Store) Remaining() int64
```

## Why `atomic.AddInt64` alone isn't the whole idiom

It's tempting to sidestep `CompareAndSwap` entirely:

```go
func (s *Store) Claim() bool {
	if atomic.AddInt64(&s.stock, -1) >= 0 {
		return true
	}
	atomic.AddInt64(&s.stock, 1) // undo the decrement we shouldn't have made
	return false
}
```

This actually works for *this exact operation*, because subtracting one is trivially reversible - if the optimistic decrement turns out to have taken stock below zero, adding one back undoes it cleanly. But that reversibility is a special property of "decrement by a fixed amount," not a general technique. The moment your update depends on the current value in a way that plain arithmetic can't undo - "set this to whichever is larger, the current value or some new observation," "only apply this write if the version hasn't changed since I read it" - there's no `+1` that puts things back the way they were.

`CompareAndSwap` generalizes to all of that: read the current value, compute *any* function of it you want, and atomically install the result **only if the value hasn't changed since you read it** - retrying the whole read-compute-install cycle if it has. This exercise's `Claim` is a good first case to practice that loop on precisely because it's simple enough to reason about by hand, but the loop itself is the thing worth learning - it's the same shape you'll reach for anywhere a lock-free update needs "read, decide, install-if-unchanged, retry."

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
