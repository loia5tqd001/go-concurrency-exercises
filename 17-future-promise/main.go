//////////////////////////////////////////////////////////////////////
//
// Future returns a channel before ComputeExpensive finishes.
// The channel delivers exactly one result for the key.
// Repeating a key while it is running or cached must reuse that work.
// Each key must be computed at most once.
// Different keys must still compute concurrently.
//
//     func Future(key string) <-chan int
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Future returns a channel for one computed value.
// The naive version computes and blocks before returning.
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
