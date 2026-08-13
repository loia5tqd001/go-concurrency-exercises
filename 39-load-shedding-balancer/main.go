//////////////////////////////////////////////////////////////////////
//
// A production-shaped sequel to 33/33b's self-scheduling load
// balancer. Submit below is the balancer's only entry point now -
// there's no exported work channel for a caller to pick their own
// buffering strategy on. Everything after Submit - the Worker/Pool
// self-scheduling, the unbuffered inboxes, the nil-channel select that
// dispatches without ever blocking on a busy Worker - is already
// correct and doesn't need touching; it's 33b's fix, ported wholesale.
//
// What's new: incoming is a real bounded channel (capacity
// maxBacklog), not an unbounded slice. That's the fix for 33b's own
// loose end - a sustained overload now hits a hard ceiling instead of
// growing memory forever - but a bounded queue raises a question 33b
// never had to answer: what happens when it's full?
//
// BROKEN: Submit just blocks.
//
//	func (b *Balancer) Submit(req Request) error {
//		b.incoming <- req
//		return nil
//	}
//
// Once incoming, the run loop's own one-item staging slot, and every
// Worker are all occupied, the NEXT Submit call sits there waiting for
// something to finish - indefinitely, if the caller never gives up.
// That's not a deadlock (the system is still making progress; it'll
// eventually drain), but it's exactly the failure mode a real load
// balancer can't have: a caller that expected a fast yes/no now hangs
// for as long as the balancer stays saturated, with no way to know
// whether to retry, fail over, or give up.
//
// Your task: make Submit fail fast. The instant incoming has no room,
// Submit must return ErrOverloaded immediately - never block waiting
// for space to free up.
//
// Hint: the idiom is select with a default case - "try to send; if
// nobody's ready for it right now, take the other branch instead of
// waiting." That's a different flavor of non-blocking select than
// 33b's nil-channel trick: there, a case was conditionally disabled
// entirely; here, every case is real, and default is what runs when
// none of them can proceed at this instant.
//
// Keep the exported surface the same:
//
//	func NewBalancer(numWorkers, maxBacklog int) *Balancer
//	func (b *Balancer) Submit(req Request) error
//
// Don't change Request, Worker, or Pool.
//

package main

import (
	"container/heap"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// ErrOverloaded is returned by Submit when the balancer's incoming
// queue is full and it can't accept any more work right now.
var ErrOverloaded = errors.New("balancer overloaded")

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
// report completions - and never admits more than maxBacklog requests
// beyond what's already running.
type Balancer struct {
	pool     Pool
	done     chan *Worker
	incoming chan Request
}

// NewBalancer starts numWorkers Workers, each already running its own
// goroutine, plus the Balancer's own internal dispatch loop. Each
// Worker's inbox is unbuffered - dispatch never leans on a buffer to
// avoid blocking, exactly as 33b established. incoming is the one and
// only bounded buffer in this design, sized by maxBacklog.
func NewBalancer(numWorkers, maxBacklog int) *Balancer {
	b := &Balancer{
		done:     make(chan *Worker),
		incoming: make(chan Request, maxBacklog),
	}
	for i := 0; i < numWorkers; i++ {
		w := &Worker{requests: make(chan Request)}
		heap.Push(&b.pool, w)
		go w.work(b.done)
	}
	go b.run()
	return b
}

// run is the Balancer's internal dispatch loop: it drains incoming
// (staging at most one Request at a time in held while it waits for a
// Worker to be ready) and b.done, dispatching without ever blocking on
// a Worker that isn't ready to receive right now. Already correct -
// do not touch; this is 33b's fix, adapted to a bounded incoming
// channel and a single staged item instead of an unbounded slice.
func (b *Balancer) run() {
	var held *Request

	for {
		var dispatch chan<- Request
		var head Request
		var w *Worker
		if held != nil {
			w = b.pool[0]
			dispatch, head = w.requests, *held
		}

		var incoming chan Request
		if held == nil {
			incoming = b.incoming
		}

		select {
		case req := <-incoming:
			r := req
			held = &r

		case dispatch <- head:
			held = nil
			w.pending++
			heap.Fix(&b.pool, w.index)

		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}

// Submit hands req to the Balancer to run. It must never block the
// caller: if the incoming queue is full, it returns ErrOverloaded
// immediately instead of waiting for space to free up.
func (b *Balancer) Submit(req Request) error {
	b.incoming <- req
	return nil
}

func main() {
	const numWorkers = 3
	const maxBacklog = 4
	const numRequests = 20

	balancer := NewBalancer(numWorkers, maxBacklog)

	fmt.Printf("submitting %d requests to a pool of %d workers with a backlog of %d...\n", numRequests, numWorkers, maxBacklog)

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

			submitted := make(chan error, 1)
			go func() { submitted <- balancer.Submit(req) }()

			select {
			case err := <-submitted:
				if err != nil {
					fmt.Printf("request %d rejected: %v\n", i, err)
					return
				}
			case <-time.After(2 * time.Second):
				fmt.Printf("request %d's Submit call never returned - looks like it's blocking instead of failing fast\n", i)
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
	fmt.Println("...but a Submit that blocks instead of failing fast can hang a caller for as long as the balancer stays saturated.")
}
