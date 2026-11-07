# Replicated Requests: Racing Redundant Calls for Lower Tail Latency

`FetchFastest` sends one request to several `Replica` handlers at the
same time. See `mockreplica.go`. It returns the first answer. One slow
replica does not hold back the caller. This is a hedged-request pattern.
It is used to limit slow tail responses.

Today, the code returns the first answer. But it leaks every loser:

```
                     ┌─▶ replica-A r(nil) ── sleeps full latency ── (nobody's listening)
FetchFastest(done) ──┼─▶ replica-B r(nil) ── answers first ──▶ caller gets the value
                     └─▶ replica-C r(nil) ── sleeps full latency ── (nobody's listening)
```

Each replica starts with a `nil` `done` channel. A nil channel never
closes. Losers cannot learn that the caller has an answer. They sleep
for their full delay and leak goroutines.

Goal: every loser stops as soon as one replica wins, or when the
caller's `done` closes:

```
                     ┌─▶ replica-A r(stop) ── sees stop closed ──▶ exits early
FetchFastest(done) ──┼─▶ replica-B r(stop) ── answers first ──▶ caller gets the value
                     └─▶ replica-C r(stop) ── sees stop closed ──▶ exits early
                              (winning OR done firing closes stop for every replica)
```

## Your task

Fix `FetchFastest`. Once there is a winner, or the caller's `done`
closes, stop every other replica. Pass a stop channel to each replica.
Make sure a lost replica reacts to it. Do not let it run to completion.

Keep the signatures the same:

```go
type Replica func(done <-chan struct{}) (string, error)

func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error)
```

- `FetchFastest` calls every replica concurrently. It returns the first
  `(value, error)` result. Ignore later results.
- If the caller's `done` closes before any replica answers, return
  promptly with an error and no winner. This includes a `done` that is
  already closed at the start.
- There are two stop triggers. One replica wins. Or the caller's `done`
  fires first. In both cases, every running replica must be told to stop
  through its own `done` argument.

## Test your solution

The tests must pass:
```
go test
go test --race
```
