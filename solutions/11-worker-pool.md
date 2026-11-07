# Worker Pool: Batch Job Processor with Partial Failures — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `11-worker-pool/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`ProcessJobs` receives a slice of `Job` values. It runs each with
`RunJob` from `mockjobs.go`. `RunJob` sleeps for `JobLatency`, 80ms. It
returns `ErrJobFailed` when `ShouldFail` is true. The starting version
runs each job one at a time:

```go
func ProcessJobs(jobs []Job) []Result {
	results := make([]Result, 0, len(jobs))
	for _, j := range jobs {
		err := RunJob(j)
		results = append(results, Result{JobID: j.ID, Err: err})
	}
	return results
}
```

Your task is to use a fixed pool of workers. Each worker reads jobs from
a shared channel and calls `RunJob`. Each writes one `Result`. A
coordinating goroutine with `sync.WaitGroup` closes results after all
workers finish. Each job runs exactly once. Do not skip, repeat, or race.
Result order does not matter. Keep this signature:
`func ProcessJobs(jobs []Job) []Result`.

## Why the naive version is wrong

The starting version is correct. It has no race. It adds every result
once. Its doc comment says the same, and the tests confirm it:

```
--- FAIL: TestProcessJobsIsBounded (0.00s)
    check_test.go:138: high-water mark of concurrent RunJob calls = 1; jobs are
        being processed one at a time instead of by a pool of workers
FAIL
```

`TestProcessJobsCorrectness` and `TestProcessJobsRace` pass. There is no
correctness bug to fix. The problem is lack of parallel work. Every
`RunJob` uses one goroutine, so only one job runs.

`TestProcessJobsIsBounded` uses
`JobConcurrencyHighWaterMark` from `mockjobs.go`. This value tracks the
largest number of jobs. It must be above 1 and below the job count.

The starting version reports 1. One goroutine per job would report every
job. A pool must keep the count fixed even when the input grows.

## Approach 1: Fixed-size worker pool, fan-in through a results channel

```go {28,32,33}
const numWorkers = 4

type Result struct {
	JobID int
	Err   error
}

func ProcessJobs(jobs []Job) []Result {
	jobCh := make(chan Job)
	resultCh := make(chan Result)

	var wg sync.WaitGroup
	wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go func() {
			defer wg.Done()
			for j := range jobCh {
				err := RunJob(j)
				resultCh <- Result{JobID: j.ID, Err: err}
			}
		}()
	}

	go func() {
		for _, j := range jobs {
			jobCh <- j
		}
		close(jobCh)
	}()

	go func() {
		wg.Wait()
		close(resultCh)
	}()

	results := make([]Result, 0, len(jobs))
	for r := range resultCh {
		results = append(results, r)
	}
	return results
}
```

There are three parts:

- **`jobCh` is the work queue.** `numWorkers` goroutines use
  `for j := range jobCh`. Each job goes to one worker. Go sends an
  unbuffered value to one receiver, so no job repeats or drops.
- **A feeder sends jobs.** It closes `jobCh` after the input ends. The
  worker loops then end.
- **`resultCh` collects results.** Every worker sends here. The caller
  uses `for r := range resultCh`. A separate goroutine waits with
  `wg.Wait()` and then closes `resultCh`.

The close must use a separate goroutine. If `wg.Wait()` ran inline, it
would wait for workers. The workers would wait to send to `resultCh`.
Nothing would drain it, so the code would deadlock.

Only `resultCh` carries results. Workers do not write a shared slice.
Each worker calls `Done` when it exits. The caller uses `range` over
`resultCh`. There is no race. `TestProcessJobsRace` passes under
`-race`.

## Approach 2: Fixed-size worker pool, direct indexed writes into a pre-sized slice (alternative)

```go {9,20}
const numWorkers = 4

type Result struct {
	JobID int
	Err   error
}

func ProcessJobs(jobs []Job) []Result {
	results := make([]Result, len(jobs))

	jobCh := make(chan Job)

	var wg sync.WaitGroup
	wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go func() {
			defer wg.Done()
			for j := range jobCh {
				err := RunJob(j)
				results[j.ID] = Result{JobID: j.ID, Err: err}
			}
		}()
	}

	for _, j := range jobs {
		jobCh <- j
	}
	close(jobCh)

	wg.Wait()

	return results
}
```

This pre-sizes `results` to `len(jobs)`. Each worker writes to
`results[j.ID]`. There is no `resultCh` and no closer goroutine. The main
goroutine feeds `jobCh`, waits on `wg.Wait()`, and returns `results`.

This is race-free for another reason. Many workers write `results`.
Each job has a unique `ID`, so workers write different elements. Go does
not treat writes to different slice elements as a race. The 50-job
stress test passes under `go test -race`.

This design needs one rule. Every `Job.ID` must be unique and in
`[0, len(jobs))`. `testJobs` in `check_test.go` and `jobs` in `main`
use `0..n-1`, so they meet this rule. The signature does not promise it.

IDs like 100, 200, or 300 cause an index error. Duplicate IDs can
overwrite a result. A caller can pass any `[]Job`. The starting version
and Approach 1 accept any ID. They only copy the ID into `Result`.

Use Approach 1 by default. Use Approach 2 only when the ID is already a
dense array index.

## Key takeaways

- A slow starting point is not always a correctness bug. Here the code
  is correct but runs jobs one at a time.
- A worker pool decouples job count from worker count. `numWorkers` stays
  fixed for 20 jobs or 20,000 jobs.
- Use `close(jobCh)` after feeding to end each worker's range loop. A
  separate goroutine runs `wg.Wait()`, then `close(resultCh)`. Call
  `close` only once on each channel.
- A results channel and direct indexed writes can both be race-free.
  They rely on different rules. Indexed writes need dense, unique IDs.
