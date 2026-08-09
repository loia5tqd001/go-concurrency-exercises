# Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking

Given is a `Pool`: a fixed-size worker pool that any number of
unrelated goroutines can submit jobs to via `Submit`, and that can be
shut down via `Close`. Picture an HTTP handler that submits a
background job to a shared `Pool` on every request - dozens of
requests can be in-flight, each calling `Submit` from its own
goroutine, at the exact moment the process starts a graceful shutdown
and calls `Close`.

Right now `Pool` has no coordination between `Submit` and `Close`
whatsoever:

```go
func (p *Pool) Submit(job func()) (accepted bool) {
	p.wg.Add(1)
	p.jobs <- job
	return true
}

func (p *Pool) Close() {
	p.wg.Wait()
	close(p.jobs)
}
```

`Close` waits for every job accepted so far to finish, then closes the
`jobs` channel. `Submit` just sends on that channel, unconditionally.
If **any** goroutine calls `Submit` while another goroutine is running
`Close`, there is a genuine race between that send and `Close`'s
`close(p.jobs)` - and sending on a closed channel panics. This isn't a
rare corner case to shrug off: it's the ordinary, expected way
`Submit` and `Close` get called in any program where more than one
goroutine might reach for the same `Pool` near shutdown time.

Your task is to fix `Pool` so that:

- `Submit` is safe to call concurrently with `Close`, from any number
  of goroutines, without ever panicking.
- `Submit` returns `accepted = true` and guarantees `job` **will**
  run, if it was called before `Close` finished shutting the pool
  down; it returns `accepted = false` (and never runs `job`) if the
  pool was already closed.
- `Close` stops accepting new jobs and does not return until every
  job `Submit` ever reported as accepted has **fully finished
  running** - not merely been handed to a worker, actually finished.

The signatures must stay the same:

```go
func NewPool(workers int) *Pool
func (p *Pool) Submit(job func()) (accepted bool)
func (p *Pool) Close()
```

## Why "wrap the send in `recover`" isn't enough

It's tempting to just catch the panic:

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

This stops the panic from escaping, but leaves the `sync.WaitGroup`
accounting broken: `Add(1)` already ran before the panic, and nothing
ever calls the matching `Done()` for that job, since it was never
delivered to a worker. `Close`'s `wg.Wait()` now waits on a counter
that can never reach zero again. Using `recover` to paper over a race
instead of preventing the race is a common trap - it silences the
symptom you noticed (the panic) while leaving the property you
actually need (no lost bookkeeping, no dropped-but-"accepted" jobs)
unverified.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
