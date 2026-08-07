//////////////////////////////////////////////////////////////////////
//
// Given is a self-scheduling load balancer, modeled directly on the
// one from Rob Pike's 2012 "Go Concurrency Patterns" talk: a Pool of
// Workers ordered as a min-heap by how many requests each is currently
// carrying (pending), so heap.Pop always hands back whichever Worker
// is least loaded right now. Every Worker runs its own goroutine
// (Worker.work, already correct - do not touch it) that executes
// requests off its own inbox one at a time and, after each one, sends
// itself back on a shared done channel to report "I just freed up."
//
// Balancer.Balance is supposed to run forever, doing two things:
// dispatch every incoming Request to the currently least-loaded
// Worker, AND process every value that arrives on done by decrementing
// that Worker's pending count and fixing its position in the heap -
// otherwise the heap's whole reason for existing (knowing who's
// actually free) silently rots the moment a Worker finishes its very
// first request.
//
// The naive implementation below only does the first half. Its select
// loop has exactly one case: read from work, dispatch it. Nothing in
// Balance ever receives from b.done. That looks completely fine for
// exactly as many requests as there are Workers - each gets its own
// Worker on the first round of dispatch, and every one of them
// finishes correctly. But watch what happens to a Worker after it
// finishes: it calls `done <- w`, and since nothing is ever listening
// on b.done, that send blocks forever. The Worker's goroutine is now
// permanently stuck one line before it would loop back to receive its
// next request - it will never process another one, no matter how
// long the program runs.
//
// The instant a request arrives that has to be routed to a Worker
// that's already finished its first job (which happens as soon as
// there have been more requests than there are Workers), dispatch's
// own `w.requests <- req` blocks forever waiting for a Worker.work
// goroutine that is never coming back to receive it. Since dispatch is
// called synchronously from inside Balance's only loop, THAT blocks
// the entire Balancer - every request behind it in the work channel,
// no matter which Worker it was destined for, now waits forever too.
//
// Your task is to fix Balance so it also drains b.done and updates the
// pool accordingly, so the load balancer keeps working correctly no
// matter how many requests arrive over its Workers' lifetime - not
// just for the first burst. The exported surface must stay the same:
//
//     func NewBalancer(numWorkers int) *Balancer
//     func (b *Balancer) Balance(work <-chan Request)
//
// You should not need to change Request, Worker, or Pool at all.
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

// Worker is one backend able to run Requests, one at a time, off its
// own inbox. pending tracks how many requests are currently queued or
// in flight on this Worker (including the one it's actively running).
// index is bookkeeping required by container/heap - do not set it
// yourself, Pool's Push/Swap/Pop already maintain it.
type Worker struct {
	requests chan Request
	pending  int
	index    int
}

// work is this Worker's own goroutine: it runs requests one at a time
// off its inbox, delivers each result on that request's own reply
// channel, and then reports itself back on done so the Balancer learns
// it just freed up. This is already correct - nothing here needs to
// change.
func (w *Worker) work(done chan *Worker) {
	for req := range w.requests {
		req.c <- req.fn()
		done <- w
	}
}

// Pool is a min-heap of *Worker ordered by pending load, so the
// least-loaded Worker is always at the root: heap.Pop(&pool) hands
// back whichever Worker currently has the fewest requests queued or
// running. Already correct - nothing here needs to change either.
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

// Balancer fans work out across a Pool of Workers, always handing a
// new Request to whichever Worker is currently least loaded, and
// keeping that ordering current as Workers report completions.
type Balancer struct {
	pool Pool
	done chan *Worker
}

// requestBacklogPerWorker sizes each Worker's inbox. dispatch's send to
// a Worker's requests channel happens synchronously inside Balance's
// only goroutine, so if that channel were unbuffered, dispatching to a
// Worker that's mid-flight - already running one request and about to
// report a PRIOR completion on done before it loops back to receive
// again - would block Balance on that exact Worker, which in turn
// can't loop back to receive until Balance (stuck in that very send)
// gets around to receiving its done report. A generous buffer avoids
// that circular wait; it's unrelated to the bug this exercise is
// about.
const requestBacklogPerWorker = 16

// NewBalancer creates a Balancer backed by numWorkers Workers, each
// already running its own goroutine, ready for Balance to be called on
// it.
func NewBalancer(numWorkers int) *Balancer {
	b := &Balancer{done: make(chan *Worker)}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request, requestBacklogPerWorker)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	return b
}

// Balance is supposed to run forever, dispatching every Request that
// arrives on work to the currently least-loaded Worker, and updating
// the pool's load ordering every time a Worker reports completion on
// b.done.
//
// NAIVE / BROKEN: it only ever looks at work. Nothing here ever
// receives from b.done, so the pool's pending counts only ever go up,
// never down - and once every Worker has finished one request, every
// subsequent dispatch blocks forever.
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}

// dispatch hands req to whichever Worker currently has the fewest
// pending requests, and re-inserts it into the pool with pending
// incremented to reflect the new request it's now carrying. Already
// correct - the bug in this exercise is entirely about what Balance
// does (or rather, doesn't do) with b.done, not about dispatch itself.
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
