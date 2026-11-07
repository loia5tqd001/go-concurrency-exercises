//////////////////////////////////////////////////////////////////////
//
// This follows exercise 33. Its Balance already reads work and done.
// Each Worker inbox is unbuffered; a test requires this.
//
// BROKEN: Balance sends to a worker inside its select loop.
// If that worker is busy, the send blocks Balance.
// Balance then cannot read done from any worker.
// One busy worker can freeze the whole pool.
//
// Rewrite Balance so it never blocks on a worker send.
// Queue waiting requests inside Balance.
// The least-loaded worker must get the next queued request.
//
// Hint: A nil channel disables a select case.
// Use a nil channel when no send can proceed.
// Keep the dispatch send inside the same select as work and done.
//
// Keep the public API:
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

// Request is one unit of work.
// c receives the result from fn.
type Request struct {
	fn func() int
	c  chan int
}

// Worker runs requests one at a time from its inbox.
// pending counts queued and running requests.
// Pool maintains index for container/heap; do not set it yourself.
type Worker struct {
	requests chan Request
	pending  int
	index    int
}

// work runs requests for this worker. It is already correct.
func (w *Worker) work(done chan *Worker) {
	for req := range w.requests {
		req.c <- req.fn()
		done <- w
	}
}

// Pool is a min-heap ordered by pending work.
// heap.Pop returns the least-loaded worker.
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

// Balancer sends work to the least-loaded worker.
// It updates the heap when a worker finishes.
type Balancer struct {
	pool Pool
	done chan *Worker
}

// NewBalancer starts numWorkers workers.
// Each worker has an unbuffered inbox by design.
func NewBalancer(numWorkers int) *Balancer {
	b := &Balancer{done: make(chan *Worker)}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	return b
}

// Balance sends work and handles worker completions.
// It must never block on a worker that is not ready.
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
