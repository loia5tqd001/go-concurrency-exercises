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

// JobLatency is the duration of one simulated job.
const JobLatency = 80 * time.Millisecond

// ErrJobFailed marks a simulated job failure.
var ErrJobFailed = errors.New("job failed")

// Job is one unit of work.
type Job struct {
	ID         int
	ShouldFail bool
}

// jobConcurrency tracks active calls for tests.
var jobConcurrency struct {
	mu            sync.Mutex
	current       int
	highWaterMark int
}

// ResetJobConcurrencyTracking clears the recorded peak.
func ResetJobConcurrencyTracking() {
	jobConcurrency.mu.Lock()
	defer jobConcurrency.mu.Unlock()
	jobConcurrency.current = 0
	jobConcurrency.highWaterMark = 0
}

// JobConcurrencyHighWaterMark returns the recorded peak.
func JobConcurrencyHighWaterMark() int {
	jobConcurrency.mu.Lock()
	defer jobConcurrency.mu.Unlock()
	return jobConcurrency.highWaterMark
}

// RunJob sleeps for JobLatency, then returns a deterministic result.
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
