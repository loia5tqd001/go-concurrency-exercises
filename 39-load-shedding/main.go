//////////////////////////////////////////////////////////////////////
//
// Queue is a fixed-size pool of workers processing jobs handed to it
// via Submit - think an app's telemetry client: every request calls
// Submit to record a metric, a small background pool aggregates and
// ships them, and the actual request-handling code must never be
// slowed down by that bookkeeping.
//
// Right now Submit is a plain blocking send:
//
//	func (q *Queue) Submit(job Job) error {
//		q.jobs <- job
//		return nil
//	}
//
// jobs is a real bounded channel (capacity capacity), not something
// that grows without limit - so once it, plus every worker, are all
// full, this send has nowhere to go:
//
//   jobs (cap capacity): FULL, every worker: busy
//
//   next Submit(job) ──▶ q.jobs <- job ──▶ blocks... waiting for
//                          ANYTHING to free up (not a deadlock - the
//                          workers are still draining - but the
//                          caller has no idea how long)
//
// That's fine for a caller who's SUPPOSED to feel the slowdown. It's
// not fine here: Submit is on the hot path of whatever's calling it,
// and every millisecond it blocks is a millisecond that has nothing
// to do with serving the actual request - it's purely overhead from
// recording a metric about it.
//
// Your task: make Submit fail fast. The instant jobs has no room,
// Submit must return ErrOverloaded immediately - never block waiting
// for space to free up.
//
// Hint: select+default tries a send once; if nothing's ready this
// instant, default runs instead of waiting.
//
// Keep the exported surface the same:
//
//	func NewQueue(workers, capacity int) *Queue
//	func (q *Queue) Submit(job Job) error
//

package main

import (
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// ErrOverloaded is returned by Submit when jobs is full and Queue
// can't accept any more work right now.
var ErrOverloaded = errors.New("queue: overloaded")

// Job is one unit of work submitted to the Queue: Run is the work
// itself, and Result is where its return value is delivered.
type Job struct {
	Run    func() int
	Result chan int
}

// Queue is a fixed-size pool of workers that run Jobs handed to it
// via Submit, backed by a bounded backlog.
type Queue struct {
	jobs chan Job
}

// NewQueue starts workers long-lived goroutines, each pulling Jobs off
// a shared, capacity-bounded channel and running them one at a time.
func NewQueue(workers, capacity int) *Queue {
	q := &Queue{jobs: make(chan Job, capacity)}

	for i := 0; i < workers; i++ {
		go q.worker()
	}

	return q
}

func (q *Queue) worker() {
	for job := range q.jobs {
		job.Result <- job.Run()
	}
}

// Submit hands job to a worker to run. It returns ErrOverloaded
// instead of job ever running if the Queue has no room for it right
// now. Submit may be called concurrently, from any number of
// goroutines, and must never block the caller.
func (q *Queue) Submit(job Job) error {
	q.jobs <- job
	return nil
}

func main() {
	q := NewQueue(2, 4)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			result := make(chan int, 1)
			err := q.Submit(Job{
				Run: func() int {
					time.Sleep(time.Duration(10+rand.Intn(40)) * time.Millisecond)
					return i
				},
				Result: result,
			})
			if err != nil {
				fmt.Printf("job %d dropped: %v\n", i, err)
				return
			}
			fmt.Printf("job %d completed, returned %d\n", i, <-result)
		}()
	}
	wg.Wait()
}
