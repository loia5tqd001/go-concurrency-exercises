//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// Under light load, every accepted job must complete correctly.
func TestAcceptedJobsEventuallyComplete(t *testing.T) {
	const workers = 3
	const capacity = 30
	const numJobs = 12

	q := NewQueue(workers, capacity)

	results := make([]chan int, numJobs)
	for i := range results {
		i := i
		results[i] = make(chan int, 1)
		job := Job{
			Run: func() int {
				time.Sleep(5 * time.Millisecond)
				return i * i
			},
			Result: results[i],
		}
		if err := q.Submit(job); err != nil {
			t.Fatalf("job %d: expected Submit to succeed under light load, got %v", i, err)
		}
	}

	for i, c := range results {
		select {
		case got := <-c:
			if want := i * i; got != want {
				t.Errorf("job %d = %d, want %d", i, got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("job %d never completed", i)
		}
	}
}

// Fill the workers and backlog with blocked jobs.
// Submit must return ErrOverloaded without blocking.
func TestSubmitFailsFastWhenQueueIsFull(t *testing.T) {
	const workers = 1
	const capacity = 2
	const perCallDeadline = 200 * time.Millisecond

	q := NewQueue(workers, capacity)

	block := make(chan struct{})
	defer close(block) // Let blocked jobs finish.

	submit := func(job Job) (err error, returnedInTime bool) {
		done := make(chan error, 1)
		go func() { done <- q.Submit(job) }()
		select {
		case err := <-done:
			return err, true
		case <-time.After(perCallDeadline):
			return nil, false
		}
	}

	sawOverloaded := false
	// Use extra attempts so exact capacity bookkeeping is not required.
	const attempts = capacity + workers + 5
	for i := 0; i < attempts; i++ {
		job := Job{
			Run:    func() int { <-block; return 0 },
			Result: make(chan int, 1),
		}
		err, ok := submit(job)
		if !ok {
			t.Fatalf("Submit attempt %d blocked for over %s instead of failing fast - "+
				"looks like it's still a blocking send instead of select/default", i, perCallDeadline)
		}
		if err != nil {
			if !errors.Is(err, ErrOverloaded) {
				t.Fatalf("Submit attempt %d returned an unexpected error: %v", i, err)
			}
			sawOverloaded = true
			break
		}
	}

	if !sawOverloaded {
		t.Fatalf("expected ErrOverloaded within %d submits once the queue is saturated, got none", attempts)
	}
}

// Concurrent submitters must not race.
// A submitter may retry a temporary overload.
func TestQueueConcurrentSafety(t *testing.T) {
	const workers = 5
	const capacity = 200
	const numJobs = 100
	const maxRetries = 20

	q := NewQueue(workers, capacity)

	var wg sync.WaitGroup
	wg.Add(numJobs)
	for i := 0; i < numJobs; i++ {
		i := i
		go func() {
			defer wg.Done()

			c := make(chan int, 1)
			job := Job{
				Run:    func() int { return i },
				Result: c,
			}

			var err error
			for attempt := 0; attempt < maxRetries; attempt++ {
				if err = q.Submit(job); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if err != nil {
				t.Errorf("job %d: never got admitted after %d retries: %v", i, maxRetries, err)
				return
			}

			<-c
		}()
	}

	allDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(allDone)
	}()

	select {
	case <-allDone:
	case <-time.After(5 * time.Second):
		t.Fatal("jobs never completed under concurrent load")
	}
}
