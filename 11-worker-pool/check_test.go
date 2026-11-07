//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"testing"
	"testing/synctest"
	"time"
)

// testJobs makes every third job fail.
func testJobs(n int) []Job {
	jobs := make([]Job, n)
	for i := range jobs {
		jobs[i] = Job{
			ID:         i,
			ShouldFail: i%3 == 0,
		}
	}

	return jobs
}

// processJobsWithTimeout turns a deadlocked pool into a fast failure.
func processJobsWithTimeout(t *testing.T, jobs []Job, timeout time.Duration) []Result {
	t.Helper()

	done := make(chan []Result, 1)
	go func() {
		done <- ProcessJobs(jobs)
	}()

	select {
	case got := <-done:
		return got
	case <-time.After(timeout):
		t.Fatalf("ProcessJobs did not return within %s - looks like a worker pool "+
			"deadlock (a channel it owns was never closed)", timeout)
		return nil
	}
}

// checkResults requires exactly one correct result per job.
func checkResults(t *testing.T, jobs []Job, got []Result) {
	t.Helper()

	if len(got) != len(jobs) {
		t.Fatalf("expected %d results, got %d", len(jobs), len(got))
	}

	byID := make(map[int]Result, len(got))
	for _, r := range got {
		if _, dup := byID[r.JobID]; dup {
			t.Errorf("job %d appeared more than once in the results", r.JobID)
		}
		byID[r.JobID] = r
	}

	for _, j := range jobs {
		r, ok := byID[j.ID]
		if !ok {
			t.Errorf("missing result for job %d", j.ID)
			continue
		}

		if j.ShouldFail && r.Err != ErrJobFailed {
			t.Errorf("job %d: expected ErrJobFailed, got %v", j.ID, r.Err)
		}
		if !j.ShouldFail && r.Err != nil {
			t.Errorf("job %d: expected nil error, got %v", j.ID, r.Err)
		}
	}
}

// TestProcessJobsCorrectness checks every job has one correct result.
// It does not require a result order.
func TestProcessJobsCorrectness(t *testing.T) {
	jobs := testJobs(20)

	got := processJobsWithTimeout(t, jobs, 5*time.Second)

	checkResults(t, jobs, got)
}

// TestProcessJobsIsBounded rejects sequential work and one goroutine per job.
// The fake clock makes the concurrency measurement deterministic.
func TestProcessJobsIsBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ResetJobConcurrencyTracking()

		const numJobs = 60
		// This accepts normal pool sizes and rejects per-job fan-out.
		const maxReasonablePoolSize = 20

		jobs := testJobs(numJobs)
		got := ProcessJobs(jobs)

		checkResults(t, jobs, got)

		hwm := JobConcurrencyHighWaterMark()

		if hwm <= 1 {
			t.Errorf("high-water mark of concurrent RunJob calls = %d; jobs are "+
				"being processed one at a time instead of by a pool of workers", hwm)
		}
		if hwm > maxReasonablePoolSize {
			t.Errorf("high-water mark of concurrent RunJob calls = %d, out of %d jobs; "+
				"want a small, FIXED-size pool (comfortably under %d workers), not "+
				"one goroutine per job", hwm, numJobs, maxReasonablePoolSize)
		}
	})
}

// TestProcessJobsRace repeats the run to expose races under `-race`.
func TestProcessJobsRace(t *testing.T) {
	for i := 0; i < 5; i++ {
		jobs := testJobs(50)

		got := processJobsWithTimeout(t, jobs, 8*time.Second)

		checkResults(t, jobs, got)
	}
}
