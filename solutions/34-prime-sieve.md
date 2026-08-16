# Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down — Suggested Solutions

> **Spoiler warning.** This file contains a full worked solution for `34-prime-sieve/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`generate` emits 2, 3, 4, 5, ... forever; every time a new prime falls
out of the chain, `Primes` splices a new `filter` stage onto the end of
it that strips that prime's multiples out of everything flowing past.
Asking for the first `n` primes builds a pipeline `n+1` goroutines
deep — one `generate`, one `filter` per prime found so far — the
classic concurrent Sieve of Eratosthenes from Rob Pike's 2012 "Go
Concurrency Patterns" talk.

`generate` and `filter` are both already correct: each respects a
`done` channel on every receive *and* every send it makes, exactly like
the or-done idiom from [exercise 07](../07-or-done-channel). The bug is
entirely in `Primes`:

```go
func Primes(n int) []int {
	ch := generate(nil)

	primes := make([]int, 0, n)
	for len(primes) < n {
		prime := <-ch
		primes = append(primes, prime)
		ch = filter(nil, ch, prime)
	}

	return primes
}
```

The task is to fix `Primes` so that once it has its `n` primes, it
shuts the entire chain down instead of abandoning it mid-flight, while
keeping the signature `func Primes(n int) []int` exactly the same.

## Why the naive version is wrong

Every value `Primes` returns is correct — the sieve logic itself has no
bug. The problem is entirely in what `Primes` hands `generate` and
every `filter` as their `done` channel: `nil`. A receive on a nil
channel inside a `select` is never ready, so the `done` case in every
stage can never fire:

```go
select {
case out <- i:
case <-done: // done is nil here — never selectable
	return
}
```

Once `Primes` has its n-th prime and returns, every one of those `n+1`
goroutines is still alive, blocked forever trying to send the next
candidate integer down a pipeline nobody is reading from anymore:

```
--- FAIL: TestPrimesDoesNotLeakGoroutines
    check_test.go:100: goroutine count went from 13 to 64 after Primes(50)
    returned (want it back near 13) - looks like the generate/filter chain
    was never told to stop and is still running in the background
```

`TestPrimesReturnsCorrectPrimes` still passes against the naive
version — the values are right, full stop. That's exactly the danger:
a function that computes a correct answer while quietly leaving a
proportional amount of garbage running behind it looks completely fine
from its return value alone, and only shows up as a slow, creeping
resource leak once something calls it enough times in a long-lived
process.

## Approach: one real `done`, shared by the whole chain

```go
func Primes(n int) []int {
	done := make(chan struct{})
	defer close(done)

	ch := generate(done)

	primes := make([]int, 0, n)
	for len(primes) < n {
		prime := <-ch
		primes = append(primes, prime)
		ch = filter(done, ch, prime)
	}

	return primes
}
```

A single `done` channel, created once per call to `Primes`, gets
threaded through `generate` and every `filter` stage spliced in after
it — not a fresh one per stage. `defer close(done)` fires once
`Primes` is about to return, whether that's after the normal loop
finishes or (if you extend this further) on an early-exit path: closing
a channel is a broadcast, so every stage currently blocked in a
`select` on it — whether waiting to receive its next candidate or
waiting to send its last one — wakes up on the same instant and exits.

This is the same or-done idiom as exercise 07, just applied across a
chain that grows to an unknown depth at runtime instead of a single
fixed stage. The chain doesn't need to know its own length or shut
down in any particular order: every stage already independently watches
the same `done`, so closing it once tears down all of them
simultaneously, regardless of how many `filter`s happen to be spliced
in by the time `n` primes have been found.

## Key takeaways

- A goroutine that's correct in isolation (`generate` and `filter`
  here, which properly implement or-done) is only as good as what it's
  given as its cancellation signal. Passing `nil` where a real `done`
  channel belongs silently defeats the whole mechanism without
  changing either function's logic at all — the bug is entirely at the
  call site.
- Correctness of the *values* returned and absence of a *goroutine
  leak* are independent properties, and a test suite has to check both
  separately. `TestPrimesReturnsCorrectPrimes` catching nothing here is
  the point: it's testing a dimension the bug doesn't touch.
- One shared `done`, not one per stage, is what makes teardown of a
  dynamically-growing pipeline simple: closing a channel is a
  broadcast to every goroutine selecting on it, so a chain that grew to
  an unknown depth at runtime still shuts down in one step, with no
  stage needing to know how many stages exist behind it.
- `runtime.NumGoroutine()`, polled with a short timeout rather than
  compared instantaneously, is a simple and effective way to catch this
  class of leak in a test — a correct implementation's goroutines exit
  within a few scheduler ticks of `done` closing, while a leaked
  goroutine is blocked forever and the count never comes back down no
  matter how long you wait.
