# Replicated Requests: Racing Redundant Calls for Lower Tail Latency

`FetchFastest` sends the same request to several redundant `Replica`
handlers (see `mockreplica.go`) concurrently and returns whichever one
answers first, so that no single replica's unpredictable tail latency
slows the caller down - the "hedged request" pattern behind Google's
tail-at-scale paper and every multi-region client that races replicas
instead of trusting the nearest one to be fast.

Today it gets the headline behavior right but leaks every loser:

```
                     ┌─▶ replica-A r(nil) ── sleeps full latency ── (nobody's listening)
FetchFastest(done) ──┼─▶ replica-B r(nil) ── answers first ──▶ caller gets the value
                     └─▶ replica-C r(nil) ── sleeps full latency ── (nobody's listening)
```

Every replica goroutine is started with a `nil` done channel, so none
of them has any way to learn that `FetchFastest` already has its
answer and moved on - a `nil` channel never fires. Each loser just
keeps sleeping out its full artificial latency long after the caller
stopped caring, leaking a goroutine per call until it self-heals.

Goal - every loser stops the instant there's a winner, or the instant
the caller's own `done` fires first:

```
                     ┌─▶ replica-A r(stop) ── sees stop closed ──▶ exits early
FetchFastest(done) ──┼─▶ replica-B r(stop) ── answers first ──▶ caller gets the value
                     └─▶ replica-C r(stop) ── sees stop closed ──▶ exits early
                              (winning OR done firing closes stop for every replica)
```

## Your task

Fix `FetchFastest` so that as soon as a winner is picked (or the
caller-supplied `done` is closed), every other in-flight replica is
told to stop via its own `done` channel - and make sure a replica
that's already lost the race actually reacts to that, rather than
continuing to run to completion regardless.

The signatures must stay the same:

```go
type Replica func(done <-chan struct{}) (string, error)

func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error)
```

- `FetchFastest` calls every replica concurrently (one goroutine each)
  and returns the value and error from whichever one sends on its own
  result channel FIRST. Once there's a winner, ignore/discard any
  later stragglers.
- If the caller-supplied `done` is closed before any replica responds
  (including if it's already closed when `FetchFastest` is called),
  `FetchFastest` returns promptly with an error and no winner.
- Two separate triggers both mean "stop now" for every in-flight
  replica: a replica winning the race, and the caller-supplied `done`
  firing before anyone won. Either way, every replica still running
  (via the `done` it receives as its own argument) must be told to
  stop instead of being left running for its full artificial latency.

## Test your solution

To complete this exercise, you must pass the tests:
```
go test
go test --race
```
