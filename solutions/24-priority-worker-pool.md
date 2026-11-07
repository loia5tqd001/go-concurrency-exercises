# Priority Worker Pool: Urgent Jobs Should Not Wait Behind a Backlog - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `24-priority-worker-pool/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting `Scheduler` has one worker goroutine. It uses one buffered channel:

```go
type Scheduler struct {
	jobs chan Job
	done chan int
}

func (s *Scheduler) worker() {
	for job := range s.jobs {
		time.Sleep(20 * time.Millisecond) // simulated work
		s.done <- job.ID
	}
}

func (s *Scheduler) Submit(job Job) {
	s.jobs <- job
}
```

`Scheduler` must do these things:

- Keep waiting jobs in a priority queue guarded by a mutex. `container/heap` is the natural tool.
- Pick the **highest-`Priority`** queued job when the worker finishes a job.
- Use FIFO order for jobs with equal priority.
- Block without busy-spinning when the queue is empty.
- Wake when `Submit` adds a job.
- Keep the API unchanged: `func NewScheduler() *Scheduler`, `func (s *Scheduler) Submit(job Job)`, and `func (s *Scheduler) Completed() <-chan int`.

## Why the naive version is wrong

`s.jobs` is a plain FIFO channel. A sent job keeps its position in the line. Its only ordering rule is submission time. Priority has no effect.

A priority-10 job can arrive while five priority-1 jobs wait in the channel. It still waits behind all five. The channel cannot reorder jobs already inside it.

Verified: the naive `main.go` fails `TestSchedulerPrioritizesUrgentJobs`:

```
--- FAIL: TestSchedulerPrioritizesUrgentJobs (0.15s)
    check_test.go:119: job 7 (priority 10) completed at position 6 in [1 2 3 4 5 6 7]; want it within the first two completions, i.e. right after whatever was already running - not stuck behind the low-priority backlog (jobs 2-6)
FAIL
```

Job 7 has priority 10. It finishes last, as the FIFO channel requires. `TestSchedulerCompletesAllJobs` and `TestSchedulerTiesBrokenByArrivalOrder` still pass. A FIFO channel already runs every job and keeps ties in arrival order. Only the priority test fails.

## A note on the test file: no `testing/synctest` here

Many timing tests in this repo use `testing/synctest`. This test uses
the real clock instead.

`24-priority-worker-pool/check_test.go` makes this choice on purpose. `NewScheduler` starts a `worker` that loops forever. It has no shutdown API. The naive worker uses `for job := range s.jobs`. A fixed worker uses an unbounded `for { ... }` loop.

`synctest.Test` needs every reachable goroutine to block or exit. Only then can the fake clock prove the test is idle. A worker that never exits prevents that. `synctest` cannot work here.

`check_test.go` uses real-clock waits based on `jobLatency`. The value is `jobLatency = 20 * time.Millisecond`. Each read from `Completed()` uses `select` and a 2-second `time.After` safety net. A correct scheduler cannot deadlock because its worker always makes progress. The timeout only limits how long a broken solution can hang.

## Approach 1: `container/heap` + `sync.Cond`

```go {30,32,74,75}
package main

import (
	"container/heap"
	"sync"
	"time"
)

// Job is a unit of work to run. Higher Priority means more important.
type Job struct {
	ID       int
	Priority int // higher number = more important
}

// queuedJob wraps a Job with the sequence number it arrived with, so
// ties in Priority can be broken by earliest submission (FIFO among
// equal priorities).
type queuedJob struct {
	job Job
	seq uint64
}

// jobHeap is a container/heap max-heap on Priority, with ties broken
// by the lower (earlier) seq.
type jobHeap []queuedJob

func (h jobHeap) Len() int { return len(h) }
func (h jobHeap) Less(i, j int) bool {
	if h[i].job.Priority != h[j].job.Priority {
		return h[i].job.Priority > h[j].job.Priority // max-heap on Priority
	}
	return h[i].seq < h[j].seq // FIFO among ties
}
func (h jobHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *jobHeap) Push(x any) { *h = append(*h, x.(queuedJob)) }

func (h *jobHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[:n-1]
	return item
}

// Scheduler runs submitted jobs on a single worker, always picking the
// HIGHEST-priority job currently waiting whenever the worker is about
// to start a new one, with ties broken by submission order. Waiting
// jobs live in an internal heap-backed priority queue guarded by mu;
// cond signals the worker when the queue goes from empty to
// non-empty, so it can block without busy-polling.
type Scheduler struct {
	mu      sync.Mutex
	cond    *sync.Cond
	queue   jobHeap
	nextSeq uint64

	done chan int // completed job IDs, in the order they finished
}

// NewScheduler creates a Scheduler and starts its single worker.
func NewScheduler() *Scheduler {
	s := &Scheduler{
		done: make(chan int, 100),
	}
	s.cond = sync.NewCond(&s.mu)
	go s.worker()
	return s
}

func (s *Scheduler) worker() {
	for {
		s.mu.Lock()
		for len(s.queue) == 0 {
			s.cond.Wait()
		}
		qj := heap.Pop(&s.queue).(queuedJob)
		s.mu.Unlock()

		time.Sleep(20 * time.Millisecond) // simulated work
		s.done <- qj.job.ID
	}
}

// Submit enqueues a job to be run.
func (s *Scheduler) Submit(job Job) {
	s.mu.Lock()
	heap.Push(&s.queue, queuedJob{job: job, seq: s.nextSeq})
	s.nextSeq++
	s.mu.Unlock()
	s.cond.Signal()
}

// Completed returns the channel of completed job IDs, in completion
// order.
func (s *Scheduler) Completed() <-chan int {
	return s.done
}
```

Design notes:

- **`heap.Pop` and the empty-queue check both run while `mu` is held.** This makes the pick atomic. A concurrent `Submit` cannot change the queue in the middle of the pick.
- **Use a loop for `sync.Cond`: `for len(s.queue) == 0 { s.cond.Wait() }`.** The condition is `len(s.queue) == 0`. The call is `sync.Cond.Wait()`.
- **Do not use an `if`.** A `Cond` wait belongs in a loop. A `Signal`
  may wake a different waiter. Always recheck the condition after a
  wake-up. With one `worker`, the loop is defensive, but still correct.
- **Call `cond.Signal()` after `mu.Unlock()`.** This is only an optimization. `sync.Cond` allows signaling with the lock held. Unlocking first avoids waking the worker just to block it again on the mutex.
- **`Less` handles the tie-break.** It compares `Priority` first, highest first for a max-heap. It compares `seq` next, lowest first. `Submit` assigns `nextSeq` under `mu`. Equal-priority jobs therefore leave the heap in submission order.
- **`jobHeap.Pop()` and `Push()` work on the slice directly.** This is the `container/heap` contract. Callers use `heap.Push` and `heap.Pop`. They do not append or truncate the slice directly. The heap invariants stay intact.

**Verified:** `gofmt -l` and `go vet ./...` are clean. `go test -race -count=10 ./...` passes repeatedly. The runs include `TestSchedulerRace`, which submits 50 jobs from 50 goroutines.

## Approach 2: One Channel per Priority Level

This version suits a **small, fixed set of priority levels**. It uses one FIFO channel per level instead of one heap. The worker scans from the highest level to the lowest on every pick.

```go {48,50,82}
package main

import (
	"fmt"
	"time"
)

// Job is a unit of work to run. Higher Priority means more important.
type Job struct {
	ID       int
	Priority int // higher number = more important
}

// numLevels bounds the fixed set of priority tiers this design
// supports: one dedicated channel per priority value 0..numLevels-1.
const (
	numLevels = 32
	levelBuf  = 256
)

// Scheduler runs submitted jobs on a single worker, always picking the
// HIGHEST-priority job currently waiting. Waiting jobs live in one
// buffered channel per priority tier (levels[p] holds jobs of
// Priority p); the worker scans tiers high-to-low on every pick, so
// within a tier plain channel FIFO handles the tie-break, and signal
// lets it block instead of busy-polling when every tier is empty.
type Scheduler struct {
	levels [numLevels]chan Job
	signal chan struct{}
	done   chan int
}

func NewScheduler() *Scheduler {
	s := &Scheduler{
		signal: make(chan struct{}, 1),
		done:   make(chan int, 100),
	}
	for p := range s.levels {
		s.levels[p] = make(chan Job, levelBuf)
	}
	go s.worker()
	return s
}

// tryPick does one non-blocking pass over the tiers from highest
// priority to lowest, returning the first job it finds (if any).
func (s *Scheduler) tryPick() (Job, bool) {
	for p := numLevels - 1; p >= 0; p-- {
		select {
		case job := <-s.levels[p]:
			return job, true
		default:
		}
	}
	return Job{}, false
}

func (s *Scheduler) worker() {
	for {
		job, ok := s.tryPick()
		if !ok {
			<-s.signal // block until Submit wakes us; no busy-poll
			continue
		}

		time.Sleep(20 * time.Millisecond) // simulated work
		s.done <- job.ID
	}
}

func (s *Scheduler) Submit(job Job) {
	p := job.Priority
	if p < 0 {
		p = 0
	}
	if p >= numLevels {
		p = numLevels - 1
	}
	s.levels[p] <- job

	select {
	case s.signal <- struct{}{}:
	default: // a wake-up is already pending; no need to queue another
	}
}

func (s *Scheduler) Completed() <-chan int {
	return s.done
}
```

Design notes and differences from Approach 1:

- **This version finds the highest priority only within one scan.** It does not guarantee the highest priority currently queued. `tryPick` checks 31 channels without holding one lock across the scan. A high-priority job can arrive after its tier was checked. It waits for the next scan. Approach 1 holds `mu` through the whole pop, so its pick is atomic.
- **Fixed tiers also mean a fixed priority range.** `Submit` clamps values outside `[0, numLevels-1]` to the nearest tier. `Priority: 32` and `Priority: 1000` both become the top tier. They then share FIFO order and lose their difference. This design fits known levels such as "low, normal, high, urgent." It does not fit open-ended priorities.
- **The memory and blocking costs differ from Approach 1.** This version allocates `numLevels` channels with `levelBuf` capacity up front. That is about 130KB per `Scheduler`, even when no jobs are queued. A heap grows only with queued jobs. `Submit` can also block when one tier is full. The heap version uses `append` under a mutex and does not block.
- **The `signal` channel is only a wake-up hint.** Its capacity is 1, and `Submit` uses a non-blocking `select` with `default`. Many submissions collapse into one wake-up. That is safe because the worker scans all tiers. It avoids a backlog of useless wake-ups.

**Verified:** `gofmt -l` and `go vet ./...` are clean. `go test -race -count=10 ./...` passes repeatedly. The runs include `TestSchedulerRace` and `TestSchedulerPrioritizesUrgentJobs`.

## Key takeaways

- A FIFO channel can process every job. It cannot reorder jobs already queued. A priority queue must reorder waiting jobs under a lock.
- `container/heap` needs `sort.Interface` and slice-based `Push` and `Pop` methods. Put the priority and FIFO tie-break in `Less`.
- Use `sync.Cond` to wait for a condition guarded by a mutex. Recheck the condition in a loop after every wake-up.
- Fixed priority tiers are simpler, but they have a weaker guarantee. They find the highest priority only within one non-atomic scan.
- `synctest` needs every reachable goroutine to block or exit. A worker with no shutdown API never satisfies that. Use real-clock waits with wide timeouts.
