//////////////////////////////////////////////////////////////////////
//
// The scheduler has one worker.
// It runs the highest-priority waiting job next.
// Jobs with equal priority run in arrival order.
// A plain FIFO channel cannot reorder a waiting backlog.
//
// Your task is to keep waiting jobs in a priority queue.
// Protect the queue with a mutex.
// When the queue is empty, wait without busy polling.
// Keep this API:
//
//     func NewScheduler() *Scheduler
//     func (s *Scheduler) Submit(job Job)
//     func (s *Scheduler) Completed() <-chan int
//

package main

import (
	"fmt"
	"time"
)

// Job is one unit of work. A higher Priority is more important.
type Job struct {
	ID       int
	Priority int // higher number = more important
}

// Scheduler runs jobs on one worker.
// The current queue is FIFO and ignores Priority.
type Scheduler struct {
	jobs chan Job
	done chan int // completed job IDs, in the order they finished
}

// NewScheduler starts the worker.
func NewScheduler() *Scheduler {
	s := &Scheduler{
		jobs: make(chan Job, 100),
		done: make(chan int, 100),
	}
	go s.worker()
	return s
}

func (s *Scheduler) worker() {
	for job := range s.jobs {
		time.Sleep(20 * time.Millisecond) // simulated work
		s.done <- job.ID
	}
}

// Submit queues a job.
func (s *Scheduler) Submit(job Job) {
	s.jobs <- job
}

// Completed returns job IDs in completion order.
func (s *Scheduler) Completed() <-chan int {
	return s.done
}

func main() {
	s := NewScheduler()

	for i := 1; i <= 5; i++ {
		s.Submit(Job{ID: i, Priority: 1})
	}

	time.Sleep(5 * time.Millisecond)
	s.Submit(Job{ID: 6, Priority: 10})

	for i := 0; i < 6; i++ {
		id := <-s.Completed()
		fmt.Printf("job %d completed\n", id)
	}
}
