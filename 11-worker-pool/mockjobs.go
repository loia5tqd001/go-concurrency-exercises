//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"sync"
	"time"
)

// JobLatency is how long a single call to RunJob takes. It stands in for
// whatever expensive work a real job would do (calling an API, touching
// a disk, crunching numbers, ...).
const JobLatency = 80 * time.Millisecond

// ErrJobFailed is returned by RunJob for any Job whose ShouldFail field
// is set.
var ErrJobFailed = errors.New("job failed")

// Job is a single unit of work to be processed by the worker pool.
type Job struct {
	ID         int
	ShouldFail bool
}

// jobConcurrency tracks how many calls to RunJob are in flight at once, so
// tests can measure how much (or how little) concurrency ProcessJobs
// actually uses without depending on wall-clock timing.
var jobConcurrency struct {
	mu            sync.Mutex
	current       int
	highWaterMark int
}

// ResetJobConcurrencyTracking clears the high-water mark tracked by
// JobConcurrencyHighWaterMark. Call it before any run whose concurrency
// you want to measure, so an earlier test's jobs don't leak into it.
func ResetJobConcurrencyTracking() {
	jobConcurrency.mu.Lock()
	defer jobConcurrency.mu.Unlock()
	jobConcurrency.current = 0
	jobConcurrency.highWaterMark = 0
}

// JobConcurrencyHighWaterMark returns the largest number of RunJob calls
// that were ever in flight at the same instant since the last call to
// ResetJobConcurrencyTracking. It's test instrumentation only - a real
// downstream dependency wouldn't expose this.
func JobConcurrencyHighWaterMark() int {
	jobConcurrency.mu.Lock()
	defer jobConcurrency.mu.Unlock()
	return jobConcurrency.highWaterMark
}

// RunJob simulates doing the work described by j. It always takes
// JobLatency to run, and deterministically returns ErrJobFailed when
// j.ShouldFail is true, nil otherwise - so tests can check correctness
// without needing a real backend.
func RunJob(j Job) error {
	jobConcurrency.mu.Lock()
	jobConcurrency.current++
	if jobConcurrency.current > jobConcurrency.highWaterMark {
		jobConcurrency.highWaterMark = jobConcurrency.current
	}
	jobConcurrency.mu.Unlock()

	time.Sleep(JobLatency)

	jobConcurrency.mu.Lock()
	jobConcurrency.current--
	jobConcurrency.mu.Unlock()

	if j.ShouldFail {
		return ErrJobFailed
	}

	return nil
}
