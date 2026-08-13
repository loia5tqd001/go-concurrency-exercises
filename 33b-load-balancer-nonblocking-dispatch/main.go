//////////////////////////////////////////////////////////////////////
//
// A direct sequel to exercise 33's self-scheduling load balancer
// (Rob Pike, "Go Concurrency Patterns", 2012). Balance below already
// does everything 33 asked for: it drains both work and b.done in the
// same select, and keeps the pool ordered with heap.Fix. That part is
// correct and doesn't need touching.
//
// What's new: every Worker's inbox is unbuffered - NewBalancer makes
// it with make(chan Request), capacity 0. That's a fixed constraint of
// this exercise (a test checks it directly), not a knob to turn back
// up.
//
// BROKEN: Balance's dispatch send - w.requests <- req - runs inside
// its own single goroutine, synchronously, before it can loop back to
// select. If the target Worker isn't parked on a receive right now
// (it's mid-job, or itself blocked sending its OWN completion on
// b.done), that send blocks - and Balance can't reach ITS done case
// for ANY Worker until it unblocks. One backed-up Worker freezes
// dispatch and done-draining for the whole pool, not just itself:
//
//   Balance picks Worker w (heap.Pop), blocks on w.requests <- req
//                                            │
//           w is off running its current job, not parked on a
//           receive yet
//                                            │
//      w finishes, tries done <- w to report back - nobody's
//      listening, because Balance is still stuck on the send above
//                                            │
//        every OTHER Worker's completions, and every later request,
//        now queue up behind that one stuck send - forever
//
// Against 33's buffered inbox this needed a burst bigger than the
// whole pool. Here it can happen on the very next request after the
// first, because there's no buffer standing between "not receiving
// yet" and "send blocks."
//
// Your task: rewrite Balance so it never blocks trying to send to any
// one Worker, no matter how backed up that Worker is - a request that
// can't be handed off immediately must queue inside Balance, not stall
// its loop. Every request must still eventually complete, and the
// least-loaded Worker must still get first claim on whatever's queued
// once it has room.
//
// Hint: the classic idiom for "conditionally enable a select case" is
// a nil channel - a nil channel is never ready, so a case that
// sends/receives on one simply never fires. Use that to make "a
// request is queued AND its target Worker can take it right now" a
// third case living in the SAME select as work and done, instead of a
// send made outside the select.
//
// Keep the exported surface the same:
//
//     func NewBalancer(numWorkers int) *Balancer
//     func (b *Balancer) Balance(work <-chan Request)
//
// Don't change Request, Worker, or Pool.
//

package main

import (
	"container/heap"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// Request is one unit of work submitted to the Balancer: fn is the
// work itself, and c is where the result of running fn will be
// delivered.
type Request struct {
	fn func() int
	c  chan int
}

// Worker is one backend that runs Requests, one at a time, off its own
// inbox. pending is how many requests it's currently carrying (queued
// + in-flight). index is container/heap bookkeeping - Pool's
// Push/Swap/Pop maintain it; don't set it yourself.
type Worker struct {
	requests chan Request
	pending  int
	index    int
}

// work is this Worker's own goroutine. Already correct - do not touch.
func (w *Worker) work(done chan *Worker) {
	for req := range w.requests {
		req.c <- req.fn()
		done <- w
	}
}

// Pool is a min-heap of *Worker ordered by pending, so heap.Pop always
// returns the least-loaded Worker. Already correct.
type Pool []*Worker

func (p Pool) Len() int           { return len(p) }
func (p Pool) Less(i, j int) bool { return p[i].pending < p[j].pending }
func (p Pool) Swap(i, j int) {
	p[i], p[j] = p[j], p[i]
	p[i].index = i
	p[j].index = j
}

func (p *Pool) Push(x any) {
	w := x.(*Worker)
	w.index = len(*p)
	*p = append(*p, w)
}

func (p *Pool) Pop() any {
	old := *p
	n := len(old)
	w := old[n-1]
	old[n-1] = nil
	w.index = -1
	*p = old[:n-1]
	return w
}

// Balancer fans work out across a Pool of Workers, always to whichever
// is currently least loaded, keeping that ordering current as Workers
// report completions.
type Balancer struct {
	pool Pool
	done chan *Worker
}

// NewBalancer starts numWorkers Workers, each already running its own
// goroutine, ready for Balance to be called on it. Each Worker's inbox
// is deliberately unbuffered - this exercise is about making Balance
// correct without a buffer to lean on.
func NewBalancer(numWorkers int) *Balancer {
	b := &Balancer{done: make(chan *Worker)}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	return b
}

// Balance should dispatch every Request from work to the least-loaded
// Worker AND update the pool as Workers report completions on b.done -
// without ever blocking on a send to a Worker that isn't ready yet.
func (b *Balancer) Balance(work <-chan Request) {
	for {
		select {
		case req := <-work:
			w := heap.Pop(&b.pool).(*Worker)
			w.requests <- req
			w.pending++
			heap.Push(&b.pool, w)

		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}

func main() {
	const numWorkers = 3
	const numRequests = 12

	balancer := NewBalancer(numWorkers)
	work := make(chan Request)
	go balancer.Balance(work)

	fmt.Printf("submitting %d requests to a pool of %d workers (unbuffered inboxes)...\n", numRequests, numWorkers)

	var wg sync.WaitGroup
	for i := range numRequests {
		wg.Go(func() {
			c := make(chan int, 1)
			req := Request{
				fn: func() int {
					time.Sleep(time.Duration(10+rand.Intn(40)) * time.Millisecond)
					return i
				},
				c: c,
			}

			select {
			case work <- req:
			case <-time.After(2 * time.Second):
				fmt.Printf("request %d was never dispatched - balancer looks wedged\n", i)
				return
			}

			select {
			case v := <-c:
				fmt.Printf("request %d completed, returned %d\n", i, v)
			case <-time.After(2 * time.Second):
				fmt.Printf("request %d never completed\n", i)
			}
		})
	}
	wg.Wait()
	fmt.Println("...but a Worker with no buffer can wedge Balance on the very next request after its first.")
}
