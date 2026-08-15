# Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down

Modeled directly on the classic concurrent prime sieve from Rob Pike's
2012 "Go Concurrency Patterns" talk — a pipeline that grows one stage
per prime found:

```
generate ──▶ filter(2) ──▶ filter(3) ──▶ filter(5) ──▶ ...  ──▶ Primes reads n values
 2,3,4,5,..   drops evens    drops ×3      drops ×5
```

`generate` emits 2, 3, 4, 5, ... forever. Every value that survives the
whole chain is prime, and the moment one falls out the end, `Primes`
splices a *new* `filter` stage onto the chain for it. Ask for the first
`n` primes and by the time you have them, the chain is `n+1`
goroutines deep — one `generate`, one `filter` per prime found so far.

`generate` and `filter` (below) both already respect a `done` channel
correctly — every `select` watches `done` on receive *and* send, same
idiom as [exercise 07](../07-or-done-channel). They're already
correct; don't change either one.

## The bug

`Primes` wires the whole chain up with `nil` as `done`:

```go
ch := generate(nil)
...
ch = filter(nil, ch, prime)
```

A receive on a nil channel inside `select` is never ready, so every
stage's shutdown case is dead code:

```go
select {
case out <- i:     // ← the only case that can ever fire
case <-done:        // ← done is nil: blocks forever, never wins
}
```

The primes `Primes` returns are all correct — the leak happens *after*
it returns:

```
Primes(50) returns its 50 primes
        │
        ▼
nobody is reading from the chain anymore ──▶ but every stage is still
                                              trying to send its next
                                              candidate downstream
        │
generate:  out <- 51        ⇐ blocks forever, no done to rescue it
filter(2): out <- 53        ⇐ blocks forever
filter(3): out <- 53        ⇐ blocks forever
   ...                          (one blocked goroutine per stage)
```

51 goroutines, leaked, every single call. Call `Primes(50)` in a loop
and it never stops growing.

## Your task

Fix `Primes` so that once it has its `n` primes, it shuts the whole
chain down — `generate` and every spliced-in `filter` — instead of
walking away from it. Signature stays the same:

```go
func Primes(n int) []int
```

## Test your solution

```
go test
go test --race
```
