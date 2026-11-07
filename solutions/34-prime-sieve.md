# Concurrent Prime Sieve: A Growing Pipeline That Must Shut Down — Suggested Solutions

> **Spoiler warning.** This file has a full solution for `34-prime-sieve/`.
> Try the exercise first. Come back if you are stuck or want to compare
> approaches.

## The problem

`generate` emits 2, 3, 4, 5, ... forever. When a new prime comes out,
`Primes` adds a new `filter` stage to the end. That stage removes the
prime's multiples from later values. Asking for the first `n` primes
builds a pipeline with `n+1` goroutines. It has one `generate`
goroutine and one `filter` per prime found. This is the classic
concurrent Sieve of Eratosthenes from Rob Pike's 2012 "Go Concurrency
Patterns" talk.

`generate` and `filter` are already correct. Each checks `done` on
every receive *and* every send. That is the or-done idiom from
[exercise 07](../07-or-done-channel). The bug is entirely in `Primes`:

```go {2,8}
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

Fix `Primes` so the whole chain stops after it gets `n` primes. Do not
leave the chain running. Keep `func Primes(n int) []int` exactly the
same.

## Why the naive version is wrong

Every value `Primes` returns is correct. The sieve logic has no bug.
The problem is the `done` channel that `Primes` passes to `generate` and
every `filter`: `nil`. A receive on a `nil` channel inside a `select`
never runs. So the `done` case in every stage never fires.

```go {3}
select {
case out <- i:
case <-done: // done is nil here — never selectable
	return
}
```

`Primes` returns after the n-th prime. Its `n+1` goroutines are still
alive. They are blocked forever on sending the next candidate down a
pipeline that nobody reads.

```
--- FAIL: TestPrimesDoesNotLeakGoroutines
    check_test.go:100: goroutine count went from 13 to 64 after Primes(50)
    returned (want it back near 13) - looks like the generate/filter chain
    was never told to stop and is still running in the background
```

`TestPrimesReturnsCorrectPrimes` still passes with the naive version.
The values are right. That is the danger. A function can return the
right answer and leave many goroutines running. Its return value looks
fine. The leak only shows up when a long-lived process calls it many
times.

## Approach: one real `done`, shared by the whole chain

```go {2,3,5,11}
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

Create one `done` channel per call to `Primes`. Pass that same channel
to `generate` and every `filter`; do not create one per stage. The
statement `defer close(done)` closes the channel before `Primes`
returns. It also runs on an early-exit path if you add one. Closing a
channel is a broadcast. Every stage blocked in a `select` wakes at
once. A stage may be waiting to receive a candidate or send one. Either
way, it exits.

This is the same or-done idiom as exercise 07. Here it applies to a
chain whose depth is not known until runtime. The chain does not need to
know its length. It does not need an orderly shutdown. Every stage
watches `done`. Closing it once stops all stages together. This works
no matter how many `filter`s were added before the n-th prime.

## Key takeaways

- A goroutine can be correct by itself. `generate` and `filter`
  implement or-done correctly. Their result still depends on the
  cancellation signal they receive. Passing `nil` instead of a real
  `done` channel disables the mechanism. Neither function's logic
  changes. The bug is at the call site.
- Correct values and no goroutine leak are separate properties. A test
  suite must check both. `TestPrimesReturnsCorrectPrimes` catches
  nothing here because the bug does not affect values.
- Use one shared `done`, not one per stage. That keeps a growing
  pipeline easy to stop. Closing a channel broadcasts to every
  goroutine that selects on it. A runtime-depth chain shuts down in one
  step. No stage needs to know how many stages follow it.
- `runtime.NumGoroutine()` can catch this leak when you poll it with a
  short timeout. Do not compare it at one instant. A correct
  implementation exits within a few scheduler ticks of `close(done)`.
  A leaked goroutine stays blocked forever. The count never comes back
  down.
