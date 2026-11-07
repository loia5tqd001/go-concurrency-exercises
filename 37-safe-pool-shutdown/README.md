# Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking

`Pool` is a fixed-size worker pool. Any number of unrelated goroutines
can call `Submit`. `Close` shuts down the pool. Picture an HTTP handler
that submits a background job on each request. Dozens of handlers may
call `Submit` at once. At the same time, graceful shutdown calls
`Close`.

Today, the two methods do not coordinate:

```go
func (p *Pool) Submit(job func()) (accepted bool) {
	p.jobs <- job
	return true
}

func (p *Pool) Close() {
	close(p.jobs)
}
```

```
goroutine A: Submit(job) ──▶ p.jobs <- job  ─────┐
                                                 ├──▶ race: which happens first?
goroutine B: Close()     ──▶ close(p.jobs)  ─────┘
                                                      send on a closed channel → PANIC
```

`Close` closes `jobs` without checking for calls in progress. `Submit`
sends without a guard. If `Submit` runs while `Close` runs, the send can
race the close. A send on a closed channel panics.

This is not rare. It is the normal result when multiple goroutines use
`Submit` and `Close` during shutdown.

## Your task

Fix `Pool` so that:

- `Submit` must be safe to call concurrently with `Close` from any
  number of goroutines. It must never panic.
- If `Submit` accepts the job before `Close` marks the pool closed, it
  returns `accepted = true`. The `job` **will** run. Once the pool is
  closed, `Submit` returns `accepted = false`. The job never runs.
- `Close` stops new jobs. It returns only after every accepted job has
  **fully finished running**. Starting a job is not enough.

Keep the signatures the same:

```go
func NewPool(workers int) *Pool
func (p *Pool) Submit(job func()) (accepted bool)
func (p *Pool) Close()
```

## Why "wrap the send in `recover`" isn't enough

Say you add a `sync.WaitGroup` to `Pool` to track accepted jobs. A
tempting close solution then looks like this:

```go {7,8}
func (p *Pool) Submit(job func()) (accepted bool) {
	defer func() {
		if recover() != nil {
			accepted = false
		}
	}()
	p.wg.Add(1)
	p.jobs <- job
	return true
}
```

```
p.wg.Add(1) ──▶ p.jobs <- job ──▶ PANIC ──▶ recover() swallows it
     │                                              │
     ▼                                              ▼
 counter incremented                    nothing ever calls the matching
                                         Done() — job never reached a worker
                                              │
                                              ▼
                              Close's wg.Wait() waits on a counter
                              that can never reach zero: hangs forever
```

`recover` hides the panic. The panic happens after `p.wg.Add(1)` and
before a worker receives the job. `recover` sets `accepted` to false.
But nothing calls `Done`. `Close` then waits forever for a count that
cannot reach zero. The job's bookkeeping is lost. Prevent the race
instead of cleaning up after it.

## Test your solution

```
go test
go test --race
```
