//////////////////////////////////////////////////////////////////////
//
// Process all jobs with a small, fixed pool of workers.
// The naive version runs one job at a time.
// Do not start one goroutine per job.
// Return one Result per job; result order does not matter.
// Close the results channel after every worker exits.
//
//     func ProcessJobs(jobs []Job) []Result
//

package main

import (
	"fmt"
	"time"
)

// Result records a job ID and its error.
type Result struct {
	JobID int
	Err   error
}

// ProcessJobs returns one result per job.
// The naive version processes jobs sequentially.
func ProcessJobs(jobs []Job) []Result {
	results := make([]Result, 0, len(jobs))
	for _, j := range jobs {
		err := RunJob(j)
		results = append(results, Result{JobID: j.ID, Err: err})
	}
	return results
}

func main() {
	jobs := make([]Job, 0, 20)
	for i := 0; i < 20; i++ {
		jobs = append(jobs, Job{
			ID:         i,
			ShouldFail: i%3 == 0,
		})
	}

	start := time.Now()
	results := ProcessJobs(jobs)
	elapsed := time.Since(start)

	var succeeded, failed int
	for _, r := range results {
		if r.Err != nil {
			failed++
		} else {
			succeeded++
		}
	}

	fmt.Printf("Processed %d jobs: %d succeeded, %d failed\n", len(results), succeeded, failed)
	fmt.Printf("Took %s\n", elapsed)
}
