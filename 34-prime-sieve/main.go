//////////////////////////////////////////////////////////////////////
//
// Given is a concurrent Sieve of Eratosthenes, modeled directly on the
// classic concurrent prime sieve from Rob Pike's 2012 "Go Concurrency
// Patterns" talk: generate emits 2, 3, 4, 5, ... forever, and every
// time a new prime falls out of the chain, a new filter stage gets
// spliced onto the end of it that strips that prime's multiples out of
// everything flowing past. Ask for the first n primes and you get a
// pipeline that's n+1 goroutines deep by the time it's done: one
// generate, and one filter per prime found so far.
//
// generate and filter both already correctly respect a done channel -
// each one's select watches done on every receive AND every send it
// makes, exactly like the or-done idiom from exercise 07. That part of
// this exercise is already solved for you; don't change either
// function.
//
// The bug is entirely in Primes. It builds the chain exactly as
// described and reads exactly n primes off the end of it, and every
// value it returns is correct - but look at what it hands generate and
// every filter as their done channel: nil. A receive on a nil channel
// inside a select is never ready, so the done case in every stage's
// select can never fire. Once Primes has its n-th prime and returns,
// every one of those n+1 goroutines is still out there, blocked
// forever trying to send the NEXT candidate integer to a pipeline
// nobody is reading from anymore. Call Primes(50) a few times in a row
// and you leak dozens of goroutines every single call, forever.
//
// Your task is to fix Primes so that once it has collected n primes,
// it shuts the entire chain down - generate and every filter stage it
// spliced in - instead of abandoning it mid-flight. The signature must
// stay the same:
//
//     func Primes(n int) []int
//

package main

import "fmt"

// generate sends 2, 3, 4, 5, ... on the returned channel, forever -
// the classic Sieve of Eratosthenes' first stage. It stops as soon as
// done is closed, instead of blocking forever trying to send the next
// integer to nobody. Already correct - nothing here needs to change.
func generate(done <-chan struct{}) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for i := 2; ; i++ {
			select {
			case out <- i:
			case <-done:
				return
			}
		}
	}()
	return out
}

// filter reads every value from in and forwards it to the returned
// channel unless it's a multiple of prime - one stage of the sieve
// chain. Like generate, it stops as soon as done is closed. Already
// correct - nothing here needs to change.
func filter(done <-chan struct{}, in <-chan int, prime int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for {
			select {
			case i, ok := <-in:
				if !ok {
					return
				}
				if i%prime != 0 {
					select {
					case out <- i:
					case <-done:
						return
					}
				}
			case <-done:
				return
			}
		}
	}()
	return out
}

// Primes returns the first n primes, using a concurrently-growing
// pipeline: generate feeds a chain of filter stages, one per prime
// found so far, each one stripping that prime's multiples out of
// everything flowing past it.
//
// NAIVE / BROKEN: it builds and drains exactly that pipeline, and the
// n primes it returns are always correct - but it wires every stage up
// with a nil done channel, so none of them can ever be told to stop.
// Every call leaks its entire n+1-goroutine chain, forever.
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

func main() {
	fmt.Println(Primes(10))
}
