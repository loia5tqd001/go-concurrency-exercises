//////////////////////////////////////////////////////////////////////
//
// Pool is a fixed-size worker pool meant to be safe to submit to from
// any number of unrelated goroutines, even while it is concurrently
// being shut down. Picture an HTTP handler that submits a background
// job to a shared Pool on every request: dozens of requests can be
// in-flight, each calling Submit from its own goroutine, at the exact
// moment the process starts a graceful shutdown and calls Close.
//
// Right now Pool does not coordinate Submit and Close AT ALL. Close
// waits for every job accepted so far to finish, then closes the
// jobs channel. Submit just sends on that channel, unconditionally.
// If ANY goroutine calls Submit while another goroutine is running
// Close, there is a real race between that send and Close's
// `close(p.jobs)` - and sending on a closed channel panics. This
// isn't a rare corner case: it's the normal, expected way Submit and
// Close get called in any program where more than one goroutine
// might reach for the same Pool near shutdown time.
//
// Your task is to fix Pool so that:
//
//   - Submit(job func()) (accepted bool) is safe to call concurrently
//     with Close, from any number of goroutines, without ever
//     panicking.
//   - Submit returns accepted = true and guarantees job WILL run if
//     it was called before Close finished shutting the pool down;
//     it returns accepted = false (and never runs job) if the pool
//     was already closed.
//   - Close stops accepting new jobs and does not return until every
//     job that Submit ever reported as accepted has fully finished
//     running - not merely been handed to a worker, actually
//     finished.
//
// The signatures must stay the same:
//
//     func NewPool(workers int) *Pool
//     func (p *Pool) Submit(job func()) (accepted bool)
//     func (p *Pool) Close()
//

package main

import (
	"fmt"
	"sync"
)

// Pool is a fixed-size pool of worker goroutines that run jobs handed
// to it via Submit.
type Pool struct {
	jobs chan func()
	wg   sync.WaitGroup
}

// NewPool starts a pool of `workers` long-lived goroutines that pull
// jobs off a shared channel and run them, one at a time per worker.
func NewPool(workers int) *Pool {
	p := &Pool{jobs: make(chan func())}

	for i := 0; i < workers; i++ {
		go p.worker()
	}

	return p
}

func (p *Pool) worker() {
	for job := range p.jobs {
		job()
		p.wg.Done()
	}
}

// Submit hands job to a worker to run. It returns whether job was
// accepted - false means the pool was already closed and job will
// never run. Submit may be called concurrently, from any number of
// goroutines, even while Close is running.
func (p *Pool) Submit(job func()) (accepted bool) {
	p.wg.Add(1)
	p.jobs <- job
	return true
}

// Close stops accepting new jobs and blocks until every job that was
// ever accepted has fully finished running.
func (p *Pool) Close() {
	p.wg.Wait()
	close(p.jobs)
}

func main() {
	p := NewPool(4)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			accepted := p.Submit(func() {
				fmt.Printf("job %d ran\n", i)
			})
			if !accepted {
				fmt.Printf("job %d rejected: pool already closed\n", i)
			}
		}()
	}

	wg.Wait()
	p.Close()
}
