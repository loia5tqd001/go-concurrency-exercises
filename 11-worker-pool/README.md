# Worker Pool: Batch Job Processor with Partial Failures

The batch processor receives a slice of `Job` values. `RunJob` runs
one job. It sleeps, then returns `ErrJobFailed` or `nil`. The
`ShouldFail` field controls which error it returns.

Today, `ProcessJobs` runs every job one at a time on the calling
goroutine. Each job is independent, but the total time still grows
with the number of jobs:

```
today (sequential):

  job0 ──▶ RunJob ──▶ job1 ──▶ RunJob ──▶ job2 ──▶ RunJob ──▶ ...
                        (one goroutine, one job at a time)

goal (fixed-size worker pool):

  job0 ┐
  job1 ├──▶ jobs chan ──▶ worker 1 ─┐
  job2 │                  worker 2 ─┼──▶ results chan ──▶ []Result
  ...  ┘                  worker N ─┘
                    (N is small and FIXED, however many jobs there are)
```

Starting one goroutine per job can work. But this may create too many
goroutines and too many parallel calls. A worker pool avoids that.
A small, fixed set of workers takes jobs from one shared queue. Each
worker runs one job at a time.

Change `ProcessJobs` to start a fixed set of worker goroutines. Each
worker reads a `Job` from a jobs channel, calls `RunJob`, and writes
one `Result`. Start another goroutine to close the results channel
after all workers finish. The caller can then collect every result.

Every job must run exactly once. Do not skip a job, run it twice, or
create a data race. Results may arrive in any order. The function
signature must stay the same:

```go
func ProcessJobs(jobs []Job) []Result
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
