//////////////////////////////////////////////////////////////////////
//
// Group is your own tiny version of golang.org/x/sync/singleflight's
// Group: N concurrent Do calls for the SAME key should share one call
// to the slow underlying fn (see Call in mockbackend.go), instead of
// each triggering it separately.
//
//   today (broken):                     goal:
//   3 concurrent Do("k", fn)            3 concurrent Do("k", fn)
//      │      │      │                    │      │      │
//      ▼      ▼      ▼                    └──┬───┴──────┘
//     fn()   fn()   fn()  ← 3 calls          first one in becomes
//                                             leader, runs fn() ONCE
//                                                     │
//                                        other 2 wait, share its
//                                        (v, err), shared = true
//
// Right now Do just calls fn directly on the calling goroutine, so
// shared is always false - for the worst possible reason: nothing is
// ever actually shared.
//
// NOT exercise 17 again: 17's Future memoizes one result forever, for
// one key, built once. This Group is keyed like the fixed 17, but
// never caches - once a call for key finishes, Group forgets it:
//
//   no entry for "k" ──Do("k")──▶ leader runs fn ──fn returns──▶ entry deleted
//           ▲                                                        │
//           └──────────────── next Do("k") is a brand-new call ──────┘
//
// Only callers genuinely concurrent with an in-flight call get to
// share its result - and share its ERROR too, not just a success.
//
// Your task is to fix Group so that:
//
//   - Do(key string, fn func() (int, error)) (int, error, bool) runs
//     fn, making sure at most one call to fn is ever in flight per key.
//   - A Do call arriving while another call for that SAME key is in
//     flight waits for it and returns its result (value AND error)
//     with shared = true, instead of calling fn again.
//   - The call that actually ran fn (or found nothing to join) returns
//     shared = false.
//   - Once a key's call finishes, it's forgotten - the next Do(key,
//     ...) starts a genuinely new call, even a split second later.
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
