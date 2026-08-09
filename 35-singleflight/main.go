//////////////////////////////////////////////////////////////////////
//
// Group is meant to be your own tiny version of
// golang.org/x/sync/singleflight's Group: a way to make sure that, no
// matter how many goroutines call Do for the SAME key at the same
// time, the slow underlying call (see Call in mockbackend.go) only
// actually runs once - every concurrent caller for that key blocks
// and shares the one result (or error) instead of triggering a
// redundant call of its own.
//
// Right now Group does none of that. Do just calls fn directly, right
// on the calling goroutine - so N concurrent callers for the same key
// trigger N separate calls to fn, each paying the full latency and
// each hitting the backend independently. shared is always reported
// as false, which also happens to be correct for this naive version,
// for the worst possible reason: nothing is ever actually shared.
//
// Unlike exercise 17 (Future), this is NOT permanent memoization: once
// a call for key finishes, Group forgets about it completely. A new
// Do(key, ...) call made afterwards - even a split second later - is
// a brand new call, not a cache hit. Only callers who are genuinely
// concurrent with an in-flight call for the same key should ever share
// its result.
//
// Your task is to fix Group so that:
//
//   - Do(key string, fn func() (int, error)) (int, error, bool) runs
//     fn and returns its result, making sure at most one call to fn
//     is ever in flight for a given key at a time.
//   - Any Do call that arrives for a key while another call for that
//     SAME key is still in flight does not call fn again - it waits
//     for the in-flight call to finish and returns its result (value
//     AND error) instead, with shared = true.
//   - The Do call that actually ran fn (or found no in-flight call to
//     join) returns shared = false.
//   - Once a call for key finishes, Group forgets it: the next Do(key,
//     ...) call, even moments later, starts a genuinely new call to
//     fn rather than replaying a cached result.
//   - Safe to call concurrently, for any number of distinct keys at
//     once, from any number of goroutines.
//
// The signature must stay the same:
//
//     func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool)
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Group makes sure that only one execution of a given key's function
// is in flight at a time; concurrent duplicate calls wait for and
// share the original call's result instead of each running fn.
type Group struct{}

// Do executes fn and returns its results, making sure at most one
// execution of fn is in flight for a given key at a time.
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
