//////////////////////////////////////////////////////////////////////
//
// This is a concurrent Sieve of Eratosthenes.
// generate emits numbers and each filter removes one prime's multiples.
// The first n primes create a pipeline of n+1 goroutines.
//
// generate and filter already respond to done. Do not change them.
//
// Primes returns correct values but leaks the whole pipeline.
// Once it has n primes, every stage keeps waiting to send.
//
// Fix Primes so it stops generate and every filter before returning.
// Keep the signature:
//
//     func Primes(n int) []int
//

package main

import "fmt"

// generate sends 2, 3, 4, 5, and so on.
// It stops when done closes. It is already correct.
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

// filter forwards values that are not multiples of prime.
// It stops when done closes. It is already correct.
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

// Primes returns the first n primes.
//
// BROKEN: It never stops the pipeline, so every call leaks goroutines.
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
