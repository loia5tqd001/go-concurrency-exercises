//////////////////////////////////////////////////////////////////////
//
// A request settles when its work finishes or its deadline fires.
// Exactly one path must call notify.
//
// Complete and Timeout use a plain bool.
// Both can read false before either writes true.
// Both then call notify, so the request settles twice.
// This can cause two responses in a real server.
//
// Fix Responder so:
// - Only the first settling call invokes notify.
// - The losing call returns false immediately.
// - No locks are used.
//
// Use sync/atomic CompareAndSwap to change pending to settled:
//
//	won := CAS(&settled, 0, 1)
//	if won: notify and return true
//	else: return false without waiting
//
// sync.Once is not suitable.
// A losing Once.Do waits for notify to finish.
// The timeout path must not wait.
//
// Keep the signatures:
//
//	func NewResponder(notify func(outcome string)) *Responder
//	func (r *Responder) Complete(result string) bool
//	func (r *Responder) Timeout() bool
//

package main

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

// Responder settles one request through Complete or Timeout.
// Only one path may call notify.
// The current plain bool has no synchronization.
type Responder struct {
	notify  func(outcome string)
	settled bool
}

// NewResponder returns a Responder that calls notify once.
func NewResponder(notify func(outcome string)) *Responder {
	return &Responder{notify: notify}
}

// Complete reports whether the result settled the request.
// False means Timeout won, so result must be discarded.
func (r *Responder) Complete(result string) bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("completed: " + result)
	return true
}

// Timeout reports whether the timeout settled the request.
// False means Complete won, so this call does nothing.
func (r *Responder) Timeout() bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("timed out")
	return true
}

func main() {
	const requests = 30
	const deadline = 50 * time.Millisecond

	var wg sync.WaitGroup
	var oversettled int64 // Requests with more than one notify. Want 0.

	for i := 0; i < requests; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			var notifications int64
			r := NewResponder(func(string) {
				atomic.AddInt64(&notifications, 1)
			})

			// Random work time lets either path win.
			work := time.Duration(rand.Intn(80)) * time.Millisecond
			go func() { time.Sleep(work); r.Complete(fmt.Sprintf("result-%d", i)) }()
			go func() { time.Sleep(deadline); r.Timeout() }()

			time.Sleep(deadline + 80*time.Millisecond)

			if n := atomic.LoadInt64(&notifications); n != 1 {
				atomic.AddInt64(&oversettled, 1)
				fmt.Printf("request %d: notify fired %d time(s), want exactly 1\n", i, n)
			}
		}()
	}
	wg.Wait()

	fmt.Printf("%d/%d requests settled more than once (want 0)\n", oversettled, requests)
	fmt.Println("...a clean 0 here doesn't mean Responder is safe: with only one Complete and one Timeout " +
		"racing per request, the unsynchronized window is nanoseconds wide and easy to miss on a single run. " +
		"`go test` widens it with many simultaneous contenders per round to catch it reliably; `go test --race` " +
		"flags the raw unsynchronized access outright, independent of whether it ever visibly misfires here.")
}
