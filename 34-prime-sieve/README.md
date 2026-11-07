# Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down

This follows Rob Pike's classic concurrent prime sieve from his 2012 Go
Concurrency Patterns talk. The pipeline grows one stage for each prime
found:

```
generate ──▶ filter(2) ──▶ filter(3) ──▶ filter(5) ──▶ ... ──▶ Primes reads n values
 2,3,4,5,..   drops evens    drops ×3      drops ×5
```

`generate` emits 2, 3, 4, 5, and so on forever. Every value that passes
all stages is prime. When a prime reaches the end, `Primes` adds a new
`filter` stage for it. Ask for the first `n` primes. The chain is then
`n+1` goroutines deep. It has one `generate` and one `filter` per prime
found.

`generate` and `filter` already respect `done` correctly. Every
`select` watches `done` on receive and send. This is the same idiom as
[exercise 07](../07-or-done-channel). Do not change either function.

## The bug

Every prime `Primes` returns is correct. The bug is what keeps running
after it returns:

```
Primes(50) returns its 50 primes
        │
        ▼
nobody is reading from the chain anymore ──▶ but every stage is still
                                              trying to send its next
                                              candidate downstream
        │
generate:  out <- 51        ⇐ blocks forever
filter(2): out <- 53        ⇐ blocks forever
filter(3): out <- 53        ⇐ blocks forever
   ...                          (one blocked goroutine per stage)
```

`Primes(50)` leaves 51 goroutines leaked. Each call adds more. A loop
over `Primes(50)` never stops growing.

## Your task

Fix `Primes`. After it has `n` primes, shut down the whole chain. This
includes `generate` and every added `filter`. Do not walk away and
leave them running. Keep the signature the same:

```go
func Primes(n int) []int
```

## Test your solution

```
go test
go test --race
```
