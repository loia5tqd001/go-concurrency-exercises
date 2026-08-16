# Priority Worker Pool: Urgent Jobs Shouldn't Wait Behind a Backlog

`Scheduler` runs submitted jobs on exactly one worker goroutine
(deliberately just one: with a single worker, the order jobs complete
in is fully determined by the order they're picked up, so there's no
ambiguity from multiple workers racing to grab the next job). Whenever
that worker is about to start a new job and more than one is waiting,
it's supposed to always pick the HIGHEST-`Priority` one - so an urgent
job submitted after a pile of low-priority ones doesn't have to sit
behind all of them.

This builds on the [worker-pool exercise](../11-worker-pool): that one
hands every job the same treatment and only cares about draining a
shared queue with several workers running in parallel, in whatever
order jobs happen to arrive. Here there's only one worker, but the
queue itself has to be priority-aware.

Right now it's a plain buffered channel - and a channel can't reorder
what's already sitting inside it, so as soon as a job is queued behind
others its `Priority` stops mattering:

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

Reimplement `Scheduler` so that it keeps waiting jobs in an internal
priority queue (`container/heap` is the natural tool) guarded by a
mutex, instead of a plain channel. Whenever the worker finishes a job
and needs to pick up the next one, it must take the highest-`Priority`
job currently in the queue; ties are broken by earliest submission
time, i.e. FIFO among jobs of equal priority. When the queue is empty
the worker has to block efficiently - a `sync.Cond`, or a small
signaling channel, either is fine, as long as it's correct and doesn't
busy-poll in a tight spin loop - until `Submit` adds something and
wakes it up.

The exported API must stay exactly the same, so `Scheduler` remains a
drop-in replacement for the version above:

```go
func NewScheduler() *Scheduler
func (s *Scheduler) Submit(job Job)
func (s *Scheduler) Completed() <-chan int
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
