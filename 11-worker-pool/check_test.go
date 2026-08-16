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

// testJobs builds n jobs with a deterministic pattern of failures:
// every third job (0-indexed) fails.
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

// processJobsWithTimeout calls ProcessJobs(jobs) on its own goroutine and
// fails fast if it doesn't return within timeout, instead of hanging
// until go test's default 10-minute deadline. A worker pool that forgets
// to close a channel it owns (the jobs channel, or the results channel)
// deadlocks silently - this turns that into a fast, readable failure.
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

// checkResults asserts that got contains exactly one Result per job in
// jobs, with the right success/failure outcome for each.
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

// TestProcessJobsCorrectness checks that every job that goes in comes
// back out exactly once, with the right outcome. It makes no
// assumption about ordering or timing, so it passes against both the
// naive sequential implementation and a worker-pool one.
func TestProcessJobsCorrectness(t *testing.T) {
	jobs := testJobs(20)

	got := processJobsWithTimeout(t, jobs, 5*time.Second)

	checkResults(t, jobs, got)
}

// TestProcessJobsIsBounded is the key test: it asserts that ProcessJobs
// uses a small, FIXED-size pool of workers - not the naive sequential
// version (which never has more than 1 job running at once), and not a
// naive one-goroutine-per-job fan-out either (which would technically be
// "concurrent" but spawns as many goroutines as there are jobs, exactly
// the thing a worker pool exists to avoid).
//
// It runs a large batch of jobs and, via RunJob's own instrumentation,
// tracks the largest number of jobs that were ever actually executing at
// the same instant (JobConcurrencyHighWaterMark). A correct worker pool's
// high-water mark sits at exactly its own (small) worker count, well
// below the job count; the sequential version's high-water mark never
// exceeds 1; a per-job fan-out's high-water mark tracks the full job
// count.
//
// synctest.Test runs this on a fake clock that only advances once every
// goroutine in the bubble is durably blocked (see RunJob's time.Sleep),
// so every worker that was actually dispatched a job is guaranteed to be
// caught mid-flight before time advances - this is a deterministic
// measurement, not a timing heuristic that could flake, and it also
// means a deadlocked pool (e.g. one that never closes a channel it owns)
// fails fast via synctest's own deadlock detection instead of hanging.
func TestProcessJobsIsBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ResetJobConcurrencyTracking()

		const numJobs = 60
		// Generous upper bound on what counts as a "small" pool for this
		// exercise - comfortably above any reasonable numWorkers choice,
		// comfortably below numJobs, so it only trips on a fan-out that
		// spawns (close to) one goroutine per job.
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

// TestProcessJobsRace stress-tests ProcessJobs across several runs
// with more jobs, to catch data races on any shared state used to
// dispatch jobs and collect results (run with `go test -race`).
func TestProcessJobsRace(t *testing.T) {
	for i := 0; i < 5; i++ {
		jobs := testJobs(50)

		got := processJobsWithTimeout(t, jobs, 8*time.Second)

		checkResults(t, jobs, got)
	}
}
