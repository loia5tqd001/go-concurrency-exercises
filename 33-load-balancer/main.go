//////////////////////////////////////////////////////////////////////
//
// This is a self-scheduling load balancer.
// Workers form a min-heap ordered by pending work.
// Balance should give work to the least-loaded worker.
//
// work -> Balance <- done <- Worker
//
// Worker.work is correct and must not change.
// Balance is broken because it never reads done.
// After a worker finishes, its done send blocks.
// The next send to that worker then blocks Balance.
// Every later request waits behind that block.
//
// Fix Balance so it also handles done. Keep the public API:
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

// This buffer lets dispatch queue work while a worker is busy.
// Without it, dispatch could block on a worker that needs to report done.
// This buffer is not this exercise's bug.
const requestBacklogPerWorker = 16

// NewBalancer starts numWorkers workers.
// Each worker runs in its own goroutine.
func NewBalancer(numWorkers int) *Balancer {
	b := &Balancer{done: make(chan *Worker)}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request, requestBacklogPerWorker)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	return b
}

// Balance sends work to the least-loaded worker.
// It must also update the pool when workers report done.
//
// BROKEN: It only reads work.
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}

// dispatch sends req to the least-loaded worker.
// It then updates pending and reinserts the worker.
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
