//////////////////////////////////////////////////////////////////////
//
// Queue runs jobs on a fixed number of workers.
// It has a bounded backlog.
//
// Submit currently blocks when the backlog and all workers are full.
// That can slow the code submitting the job.
// Submit must fail fast instead.
//
// Return ErrOverloaded as soon as there is no room.
// Hint: select with default tries a send without waiting.
//
// Keep the public API:
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

// ErrOverloaded means the Queue has no room for a job.
var ErrOverloaded = errors.New("queue: overloaded")

// Job contains work and the channel for its result.
type Job struct {
	Run    func() int
	Result chan int
}

// Queue runs Jobs on fixed workers with a bounded backlog.
type Queue struct {
	jobs chan Job
}

// NewQueue starts workers that read Jobs from one bounded channel.
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

// Submit adds job to the queue without blocking.
// It returns ErrOverloaded when the queue is full.
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
