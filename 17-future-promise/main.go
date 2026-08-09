//////////////////////////////////////////////////////////////////////
//
// Future is supposed to represent an asynchronous, memoized, keyed
// computation: calling Future(key) should kick off ComputeExpensive
// (see mockcompute.go) in the background and return a channel
// immediately - receiving from that channel blocks until the result
// is ready. Calling Future again for the SAME key - whether while the
// first call is still in flight, or long after its result is cached,
// and no matter how many goroutines call it at once - must never
// trigger a second call to ComputeExpensive for that key; every
// caller gets a channel that delivers the same result.
//
// Right now Future is not async at all - it calls ComputeExpensive
// synchronously, on the calling goroutine, before returning - so
// calling Future blocks the caller for the full 150ms up front,
// defeating the entire point of a future (you can't do other work
// while it's computing). It also recomputes from scratch on every
// single call, even for a key it has already computed before.
//
// Your task is to fix Future so that:
//
//   - Future(key string) <-chan int kicks off ComputeExpensive(key)
//     in its own goroutine and returns a channel near-instantly,
//     instead of blocking the caller.
//   - The returned channel delivers exactly one value: the result for
//     key. Receiving from it blocks until that result is ready.
//   - Calling Future(key) again for a key that's already in flight or
//     already cached always returns a channel that delivers the same
//     result, and never triggers another call to ComputeExpensive for
//     that key.
//
// The signature must stay the same:
//
//     func Future(key string) <-chan int
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Future kicks off ComputeExpensive(key) and returns a channel that
// will receive the single result once it's ready.
func Future(key string) <-chan int {
	ch := make(chan int, 1)
	ch <- ComputeExpensive(key)
	close(ch)

	return ch
}

func main() {
	const key = "report-42"
	const callers = 3

	ResetCallCount()

	var wg sync.WaitGroup
	start := time.Now()

	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			ch := Future(key)
			constructTime := time.Since(start)

			result := <-ch
			fmt.Printf("caller %d: Future returned after %s, result=%d (total elapsed %s)\n",
				i, constructTime, result, time.Since(start))
		}()
	}

	wg.Wait()

	fmt.Printf("%q was computed %d time(s) across %d concurrent callers\n", key, CallCount(), callers)
}
