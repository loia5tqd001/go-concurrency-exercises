# Heartbeats: Detecting a Stalled Worker Before It's Too Late

`DoWork` simulates a long-running worker. It processes `workUnits`
units one at a time. It sends one result per completed unit. It closes
`results` when the job is done.

`DoWork` must also send heartbeats on `heartbeat` during each unit. It
must send one about every `pulseInterval`. A heartbeat shows that the
worker is still active. Without it, a slow unit and a stuck unit look
the same. See `mockworker.go` for the per-unit timing helper.

```
healthy unit:  pulse  pulse  pulse  pulse  result
                 │      │      │      │      │
                 ▼      ▼      ▼      ▼      ▼
watcher timer: reset  reset  reset  reset  reset   ─▶ never gets close to firing,
                                                        however long the job runs

stalled unit:  pulse  (nothing - SimulateUnit blocks for StallDuration,
                 │      no more checkIns, no more results, until it
                 ▼      eventually - if ever - gives up)
watcher timer: reset ──────────── silence ──────────▶ perPulseTimeout later: FIRES
                                                        (one pulse interval after the
                                                        LAST sign of life, not "however
                                                        long the job would've taken")
```

Today, the code has two problems:

- `DoWork` sends one heartbeat at startup. It never sends another. It
  cannot show that a long unit is still running.
- `WorkWithTimeout` ignores `heartbeat`. It uses one timer for the
  whole job. A slow healthy job can fail like a stuck job. A real stall
  is not caught within one pulse interval.

## Your task

Fix both functions:

- `DoWork` must send heartbeats during each unit. It must still respect
  `done`. It must not block forever while sending to a channel with no
  receiver.
- `WorkWithTimeout` must wait on `heartbeat`, `results`, and a timer.
  Reset the timer to `perPulseTimeout` after every heartbeat or result.
  Return a non-nil error when the timer fires with neither.

Keep the signatures the same:

```go
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int)
func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error)
```

`stallAfter < 0` or `stallAfter >= workUnits` means no stall. Run
normally. A valid `stallAfter` makes that zero-based work unit simulate
a stuck worker. See `SimulateUnit` and `SetStallUnit` in
`mockworker.go`. Once stuck, that unit sends no more heartbeats or
results until it gives up. That may take much longer than a caller
should wait unless the heartbeat catches it.

## Test your solution

The tests must pass:

```
go test
go test --race
```
