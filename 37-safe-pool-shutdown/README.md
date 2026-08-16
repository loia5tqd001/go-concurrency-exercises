# Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking

`Pool` is a fixed-size worker pool that any number of unrelated
goroutines can `Submit` jobs to, and that can be shut down via
`Close`. Picture an HTTP handler submitting a background job on every
request — dozens can be in-flight, each calling `Submit` from its own
goroutine, at the exact moment the process starts a graceful shutdown
and calls `Close`.

Right now there's zero coordination between the two:

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

`Close` closes `jobs` with no regard for what's still in flight.
`Submit` sends on that channel unconditionally. If *any* goroutine calls
`Submit` while another runs `Close`, that send can race the close —
and sending on a closed channel panics. This isn't a rare corner case:
it's the ordinary way `Submit`/`Close` get called wherever more than
one goroutine might reach for the same `Pool` near shutdown.

## Your task

Fix `Pool` so that:

- `Submit` is safe to call concurrently with `Close`, from any number
  of goroutines, **without ever panicking**.
- `Submit` returns `accepted = true` and guarantees `job` **will** run,
  if called before `Close` finished shutting the pool down; returns
  `accepted = false` (never runs `job`) if the pool was already closed.
- `Close` stops accepting new jobs and doesn't return until every
  accepted job has **fully finished running** — not merely dispatched.

Signatures stay the same:

```go
func NewPool(workers int) *Pool
func (p *Pool) Submit(job func()) (accepted bool)
func (p *Pool) Close()
```

## Why "wrap the send in `recover`" isn't enough

Say you've added a `sync.WaitGroup` field to `Pool` yourself, to track
when accepted jobs have actually finished. The single most tempting
near-miss then looks like this:

```go
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

`recover` silences the symptom (the panic) while leaving the property
you actually need — no lost bookkeeping — unverified. Prevention beats
cleanup here.

## Test your solution

```
go test
go test --race
```
