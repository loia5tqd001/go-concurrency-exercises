//////////////////////////////////////////////////////////////////////
//
// A request can settle two different ways: its own work finishes, or
// its deadline fires first. Responder is supposed to make sure
// whichever happens first is the ONLY one that ever reports an
// outcome - Complete and Timeout each call notify with what happened,
// but notify must fire exactly once per request, no matter how close
// the race is. Right now Complete and Timeout both guard notify with a
// plain bool and no synchronization at all:
//
//	func (r *Responder) Complete(result string) bool {
//		if r.settled {
//			return false
//		}
//		r.settled = true
//		r.notify("completed: " + result)
//		return true
//	}
//
//   goroutine A (work finishes):  reads settled (false) ──▶ notify("completed") ──▶ settled = true
//   goroutine B (deadline fires): reads settled (false) ──▶ notify("timed out")  ──▶ settled = true
//                                    ↑ both read settled before either wrote it - notify fires TWICE
//
// Read-then-write are two separate steps, same as always: if Complete
// and Timeout both read settled as false before either writes it, both
// think they won, both call notify - the request gets reported as both
// succeeded AND timed out. In a real server this is exactly how
// "http: superfluous response.WriteHeader call" happens: a handler
// goroutine writes the success response at the very moment a timeout
// middleware writes an error response to the same connection.
//
// Your task is to fix Responder so that:
//
//   - Exactly one of Complete or Timeout ever calls notify, for any
//     single Responder - whichever reaches the settle point first.
//   - The loser - Complete if Timeout already settled it, or Timeout
//     if Complete already settled it - returns false immediately,
//     without calling notify and without waiting around for the
//     winner to finish whatever it's doing.
//
// No sync.Mutex, sync.RWMutex, or any other lock. Use sync/atomic's
// CompareAndSwap idiom instead - here it's a single check-and-flip, not
// even a retry loop, since the state only ever moves one way (pending
// -> settled):
//
//	won := CAS(&settled, 0, 1)   // install 1, but ONLY if it was still 0
//	if won:  notify, return true
//	else:    someone else already settled it - return false, don't wait
//
// Why not sync.Once? once.Do(f) really does guarantee f runs at most
// once - but a LOSING call to Do blocks on Once's internal mutex until
// the WINNING call's f has fully returned. Here the loser is a timeout
// (or a completion racing a timeout) that needs to bail out
// immediately, not wait around for however long the winner's own
// notify call takes. CompareAndSwap gives the loser an instant,
// non-blocking answer instead of making it queue behind the winner.
//
// The signatures must stay the same:
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

// Responder coordinates a single request that can settle two different
// ways - Complete, once the real work finishes, or Timeout, once the
// request's deadline fires first. Exactly one of them is supposed to
// ever call notify; right now settled is a plain bool with no
// synchronization, so both paths can see it unset and both call notify.
type Responder struct {
	notify  func(outcome string)
	settled bool
}

// NewResponder returns a Responder that will call notify exactly once,
// with whichever of Complete or Timeout wins the race to settle it.
func NewResponder(notify func(outcome string)) *Responder {
	return &Responder{notify: notify}
}

// Complete is called by the goroutine doing the actual request work,
// once it has a result. It reports whether this call won the race and
// delivered the result - false means Timeout already settled the
// request first, and result must be discarded.
func (r *Responder) Complete(result string) bool {
	if r.settled {
		return false
	}
	r.settled = true
	r.notify("completed: " + result)
	return true
}

// Timeout is called by the timer goroutine once the request's deadline
// elapses. It reports whether the timeout won the race - false means
// Complete already settled the request first, and this call must be a
// no-op.
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
	var oversettled int64 // requests whose notify fired more than once - want 0

	for i := 0; i < requests; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			var notifications int64
			r := NewResponder(func(string) {
				atomic.AddInt64(&notifications, 1)
			})

			// The work finishes after a jittered duration - sometimes before
			// the deadline, sometimes after it, the same way a real
			// downstream call's latency varies request to request.
			work := time.Duration(rand.Intn(80)) * time.Millisecond
			go func() { time.Sleep(work); r.Complete(fmt.Sprintf("result-%d", i)) }()
			go func() { time.Sleep(deadline); r.Timeout() }()

			time.Sleep(deadline + 80*time.Millisecond) // let both paths run

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
