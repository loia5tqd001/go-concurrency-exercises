//////////////////////////////////////////////////////////////////////
//
// Group is a small version of singleflight.
// Concurrent Do calls for one key must share one call to fn.
//
// today: 3 callers -> 3 fn calls
// goal:  3 callers -> 1 fn call, then 2 shared results
//
// Do is broken because it always calls fn.
//
// Unlike exercise 17, Group does not cache.
// After a key's call ends, Group forgets that key.
// Only overlapping callers share the value and error.
//
// Fix Group so:
// - At most one call per key runs at a time.
// - Waiting callers return shared = true.
// - The caller that runs fn returns shared = false.
// - A later call starts fresh.
// - Concurrent calls with different keys are safe.
//
// Keep the signature:
//
//     func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool)
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Group allows one running fn per key.
// Duplicate callers wait and share the result.
type Group struct{}

// Do runs fn, or joins an existing call for the same key.
func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
	v, err = fn()
	return v, err, false
}

func main() {
	var g Group

	const key = "report-42"

	var wg sync.WaitGroup

	start := time.Now()

	for i := 0; i < 3; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			v, err, shared := g.Do(key, func() (int, error) {
				return Call(key)
			})

			fmt.Printf("caller %d: v=%d err=%v shared=%v (at %s)\n", i, v, err, shared, time.Since(start))
		}()
	}

	wg.Wait()

	fmt.Printf("%q was called %d time(s) across 3 concurrent callers\n", key, CallCount(key))
}
