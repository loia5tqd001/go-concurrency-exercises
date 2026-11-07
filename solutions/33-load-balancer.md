# Load Balancer: Workers Schedule Themselves and Report Load — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The bug

`Balance` reads `work` only. It never reads `b.done`:

```go
func (b *Balancer) Balance(work <-chan Request) {
	for {
		req := <-work
		b.dispatch(req)
	}
}
```

This works for the first burst of up to `numWorkers` requests. Every
request gets a fresh `Worker`. The problem appears when a request must
go to a `Worker` that has already finished one job.

```
Worker finishes 1st request ──▶ done <- w blocks forever (nobody's listening)
                                          │
Balance dispatches a 2nd request to that same Worker:
    w.requests <- req ──▶ blocks forever (Worker never comes back to receive)
                                          │
        Balance's ONE goroutine is now stuck on that send
                                          │
      every later request queued behind it in `work` waits forever too
```

```
--- FAIL: TestBalancerSurvivesMoreRequestsThanWorkers (2.00s)
    check_test.go:109: request 6 never completed
```

The naive code can look correct under light load. Each backend gets one
request, so nothing queues. It only gets stuck when traffic exceeds the
pool size.

## The fix

Drain `done` in the same `select` as `work`:

```go {6,7,8}
func (b *Balancer) Balance(work <-chan Request) {
	for {
		select {
		case req := <-work:
			b.dispatch(req)
		case w := <-b.done:
			w.pending--
			heap.Fix(&b.pool, w.index)
		}
	}
}
```

Both cases run in one goroutine. So `b.pool` needs no mutex.
`dispatch` and the `done` case cannot race each other. `heap.Fix` is the
right call here. It is better than `Pop`/`Push` in this path.
`w.pending--` changes a value that is already in the heap. `Fix`
repairs the heap around that element in `O(log n)`. It uses the `index`
that `Pool.Swap` already maintains.

```
 dispatch: pending++, heap.Push          done: pending--, heap.Fix
      ┌───────────────────────┐    ┌───────────────────────┐
      ▼                       │    ▼                       │
work ─▶ Balance ───────────────────▶ Balance ◀──────────────┘
                                     ▲
                                     └── done ◀── Worker.work
```

Now a `Worker`'s full lifecycle closes. `dispatch` adds to `pending`
and sends a request. The `Worker` runs the request and reports back.
`Balance` reduces `pending` and fixes the heap. The next `dispatch`
then sees the `Worker`'s true load.

## Another detail: why `w.requests` has a buffer

`dispatch` sends from `Balance`'s own goroutine, so the send is
synchronous. Suppose `w.requests` had no buffer. A `Worker` could
finish a job and still wait on `done <- w`. A send to that `Worker`
would then deadlock. `Balance` could not reach the `done` case that
frees the `Worker`. This is a circular wait between one `Worker` and
the single `Balancer` goroutine. It can happen even if the code reads
`done` correctly. `requestBacklogPerWorker` avoids it by letting the
send queue instead of block. Pike's original version buffers its worker
channels for the same reason. The given code already does this. It is
not part of the fix above.

## `requestBacklogPerWorker` is required, not cosmetic

During review, I reduced `requestBacklogPerWorker` to `0`. It
reproduced the original failure:
`request N was never dispatched - balancer looks wedged`.
Even `1` deadlocks a single-`Worker` pool when requests arrive faster
than the `Worker` can drain them. This is not ordinary backpressure.
It is a real circular wait. `Balance`'s send runs in the same goroutine
that reads `done`. A full buffer therefore stops `done` handling for
every `Worker`, not only the busy one. `16` fits this exercise's own
traffic. It does not solve every load.
[33b](../33b-load-balancer-nonblocking-dispatch) uses capacity `0`. It
asks for a dispatcher that works without a buffer.

## Key takeaways

- The same loop that owns a self-scheduling pool's state must read its
  `done` channel. If only one side of the state changes, the pool
  quickly becomes stale.
- `heap.Fix` is for a value whose key changed while you still have its
  index. It is cheaper and more direct than `Pop` then `Push`.
- Two goroutines can deadlock by sending to each other in a fixed order.
  This can happen even after the obvious bug is fixed. A buffer on one
  side breaks the cycle.

**Verified**: the naive `main.go` fails
`TestBalancerSurvivesMoreRequestsThanWorkers`. It passes only the
sanity check where requests do not exceed workers. The fix above is
`gofmt` and `vet` clean. It passes `go test -race -count=5` without
flakes.
