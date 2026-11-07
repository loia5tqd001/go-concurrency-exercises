//////////////////////////////////////////////////////////////////////
//
// Pool has a fixed number of workers.
// Submit may run while Close is shutting the pool down.
//
// Submit sends to p.jobs. Close closes p.jobs.
// A send during Close can panic on a closed channel.
//
// Fix Pool so:
// - Submit never panics during Close.
// - accepted=true means the job will run.
// - accepted=false means the job will not run.
// - Close waits for every accepted job to finish.
//
// Keep the signatures:
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

// Pool runs submitted jobs on a fixed set of workers.
type Pool struct {
	jobs chan func()
}

// NewPool starts workers that read jobs from one shared channel.
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
	}
}

// Submit sends job to a worker.
// It returns false when the pool is closed.
func (p *Pool) Submit(job func()) (accepted bool) {
	p.jobs <- job
	return true
}

// Close rejects new jobs and waits for accepted jobs to finish.
func (p *Pool) Close() {
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
