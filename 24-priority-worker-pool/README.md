# Priority Worker Pool: Urgent Jobs Shouldn't Wait Behind a Backlog

`Scheduler` runs submitted jobs on exactly one worker goroutine. One
worker makes the completion order clear. There is no race between
workers to take the next job.

The worker must choose the highest-`Priority` job when several are
waiting. An urgent job must not wait behind low-priority jobs.

This builds on the [worker-pool exercise](../11-worker-pool). That
exercise uses several workers. It drains one shared queue in arrival
order. Here there is only one worker, but the queue must respect
priority.

Today the queue is a plain buffered channel. A channel cannot reorder
items that are already queued. Once a job is behind others, its
`Priority` no longer matters:

```
submit order:   1(p1)  2(p1)  3(p1)  4(p1)  5(p1)  6(p1)  7(p10)

today - jobs chan Job (FIFO, buffered but that doesn't help):
  [1][2][3][4][5][6][7] ──▶ worker drains strictly in send order
                            job 7 (p10) still finishes dead last

goal - priority queue, ties broken by arrival order:
  [7][1][2][3][4][5][6] ──▶ worker always pops the highest-Priority
   ▲                        job currently waiting
   └─ job 7 jumps straight to the front the instant it's submitted
```

## Your task

Replace the waiting queue with a priority queue. When the worker is
ready, it must pick the highest-`Priority` job. If priorities tie, it
must pick the earliest submitted job. An empty scheduler must sleep
without busy polling. `Submit` must wake the worker safely.

The exported API must stay exactly the same. `Scheduler` must remain a
drop-in replacement:

```go
func NewScheduler() *Scheduler
func (s *Scheduler) Submit(job Job)
func (s *Scheduler) Completed() <-chan int
```

## Test your solution

The tests must pass:

```
go test
go test --race
```
