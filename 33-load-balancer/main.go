//////////////////////////////////////////////////////////////////////
//
// A self-scheduling load balancer (Rob Pike, "Go Concurrency
// Patterns", 2012): a Pool of Workers kept as a min-heap by pending
// load, so heap.Pop always returns whichever Worker is least loaded
// right now.
//
//               dispatch: heap.Pop → least-loaded Worker
//      ┌─────────────────────────────────────────────┐
//      ▼                                              │
// work ─▶ Balance ◀──────────── done ◀──── Worker.work ┘
//          (pool: min-heap by pending)      (runs req, then
//                                             reports itself
//                                             back on done)
//
// Worker.work (below, already correct - do not touch) runs requests
// off its own inbox one at a time, then sends itself on done to say
// "I just freed up."
//
// BROKEN: Balance's select loop only has a `work` case - it never
// reads b.done. Invisible for a first burst of up to numWorkers
// requests. Wedges the instant a request routes to a Worker that
// already finished its first job:
//
//   Worker finishes 1st request -> done <- w blocks (nobody's listening)
//   Balance dispatches a 2nd request to that same Worker:
//       w.requests <- req -> blocks too (Worker never comes back to receive)
//   -> Balance's ONE goroutine is now stuck on that send
//   -> every later request queued behind it in `work` waits forever
//
// Fix Balance so it also drains b.done and updates the pool. Keep the
// exported surface the same:
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

// requestBacklogPerWorker buffers each Worker's inbox so dispatch's
// synchronous send can queue instead of deadlocking: an unbuffered
// inbox would block Balance on a Worker that's mid-flight (about to
// send its PRIOR completion on done before it loops back to receive) -
// and that Worker can't loop back until Balance, stuck on that very
// send, gets around to receiving the done report. Unrelated to this
// exercise's bug - already correct.
const requestBacklogPerWorker = 16

// NewBalancer starts numWorkers Workers, each already running its own
// goroutine, ready for Balance to be called on it.
func NewBalancer(numWorkers int) *Balancer {
	b := &Balancer{done: make(chan *Worker)}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request, requestBacklogPerWorker)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	return b
}

// Balance should dispatch every Request from work to the least-loaded
// Worker AND update the pool as Workers report completions on b.done.
//
// BROKEN: it only ever looks at work - see the top-of-file diagram.
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}

// dispatch hands req to the least-loaded Worker and re-inserts it with
// pending incremented. Already correct.
func (b *Balancer) dispatch(req Request) {
	w := heap.Pop(&b.pool).(*Worker)
	w.requests <- req
	w.pending++
	heap.Push(&b.pool, w)
}

func main() {
	const numWorkers = 3
	const numRequests = 12

	balancer := NewBalancer(numWorkers)
	work := make(chan Request)
	go balancer.Balance(work)

	fmt.Printf("submitting %d requests to a pool of %d workers...\n", numRequests, numWorkers)

	var wg sync.WaitGroup
	wg.Add(numRequests)
	for i := 0; i < numRequests; i++ {
		i := i
		go func() {
			defer wg.Done()

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
		}()
	}

	wg.Wait()
	fmt.Println("...but once more requests arrive than there are workers, some of the above never print at all.")
}
