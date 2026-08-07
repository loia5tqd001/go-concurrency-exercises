# Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down

Given is a concurrent Sieve of Eratosthenes, modeled directly on the
classic concurrent prime sieve from Rob Pike's 2012 "Go Concurrency
Patterns" talk: `generate` emits 2, 3, 4, 5, ... forever, and every
time a new prime falls out of the chain, a new `filter` stage gets
spliced onto the end of it that strips that prime's multiples out of
everything flowing past. Ask for the first `n` primes and you get a
pipeline that's `n+1` goroutines deep by the time it's done: one
`generate`, and one `filter` per prime found so far.

`generate` and `filter` both already correctly respect a `done`
channel - each one's `select` watches `done` on every receive AND every
send it makes, exactly like the or-done idiom from
[exercise 07](../07-or-done-channel). That part of this exercise is
already solved for you; don't change either function.

The bug is entirely in `Primes`. It builds the chain exactly as
described and reads exactly `n` primes off the end of it, and every
value it returns is correct - but look at what it hands `generate` and
every `filter` as their `done` channel: `nil`. A receive on a nil
channel inside a `select` is never ready, so the `done` case in every
stage's `select` can never fire. Once `Primes` has its n-th prime and
returns, every one of those `n+1` goroutines is still out there,
blocked forever trying to send the NEXT candidate integer to a
pipeline nobody is reading from anymore. Call `Primes(50)` a few times
in a row and you leak dozens of goroutines every single call, forever.

Your task is to fix `Primes` so that once it has collected `n` primes,
it shuts the entire chain down - `generate` and every `filter` stage it
spliced in - instead of abandoning it mid-flight. The signature must
stay the same:

```go
func Primes(n int) []int
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
