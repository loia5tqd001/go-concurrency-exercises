# Load Balancer: Self-Scheduling Workers That Report Their Own Load

Given is a self-scheduling load balancer, modeled directly on the one
from Rob Pike's 2012 "Go Concurrency Patterns" talk: a `Pool` of
`Worker`s ordered as a min-heap by how many requests each is currently
carrying (`pending`), so `heap.Pop` always hands back whichever
`Worker` is least loaded right now. Every `Worker` runs its own
goroutine (`Worker.work`, already correct - do not touch it) that
executes requests off its own inbox one at a time and, after each one,
sends itself back on a shared `done` channel to report "I just freed
up."

`Balancer.Balance` is supposed to run forever, doing two things:
dispatch every incoming `Request` to the currently least-loaded
`Worker`, AND process every value that arrives on `done` by
decrementing that `Worker`'s pending count and fixing its position in
the heap - otherwise the heap's whole reason for existing (knowing
who's actually free) silently rots the moment a `Worker` finishes its
very first request.

The naive implementation below only does the first half. Its select
loop has exactly one case: read from `work`, dispatch it. Nothing in
`Balance` ever receives from `b.done`. That looks completely fine for
exactly as many requests as there are `Worker`s - each gets its own
`Worker` on the first round of dispatch, and every one of them
finishes correctly. But watch what happens to a `Worker` after it
finishes: it calls `done <- w`, and since nothing is ever listening on
`b.done`, that send blocks forever. The `Worker`'s goroutine is now
permanently stuck one line before it would loop back to receive its
next request - it will never process another one, no matter how long
the program runs.

The instant a request arrives that has to be routed to a `Worker`
that's already finished its first job (which happens as soon as there
have been more requests than there are `Worker`s), `dispatch`'s own
`w.requests <- req` blocks forever waiting for a `Worker.work` goroutine
that is never coming back to receive it. Since `dispatch` is called
synchronously from inside `Balance`'s only loop, THAT blocks the entire
`Balancer` - every request behind it in the `work` channel, no matter
which `Worker` it was destined for, now waits forever too.

Your task is to fix `Balance` so it also drains `b.done` and updates
the pool accordingly, so the load balancer keeps working correctly no
matter how many requests arrive over its `Worker`s' lifetime - not just
for the first burst. The exported surface must stay the same:

```go
func NewBalancer(numWorkers int) *Balancer
func (b *Balancer) Balance(work <-chan Request)
```

You should not need to change `Request`, `Worker`, or `Pool` at all.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
