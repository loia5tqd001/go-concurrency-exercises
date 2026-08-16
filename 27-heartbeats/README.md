# Heartbeats: Detecting a Stalled Worker Before It's Too Late

Given is `DoWork`, which is supposed to simulate a long-running worker
that processes `workUnits` units of work one at a time (see
`mockworker.go` for the per-unit timing helper), sending one result
per completed unit on `results` and closing `results` once the whole
job is done. While it is actively working on a unit, it is also
supposed to pulse on `heartbeat` roughly every `pulseInterval`, for as
long as that unit takes - that pulse is the only way a caller can tell
"still working, just slow" apart from "wedged forever", since a slow
unit and a stalled one look identical to anyone who can only wait for
a result.

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

Today, neither half of that exists:

- `DoWork`'s heartbeat is decorative - it fires one pulse the instant
  the goroutine starts, then never again, no matter how long a unit
  takes or whether one stalls outright.
- `WorkWithTimeout` never looks at `heartbeat` at all, and instead of a
  timer that resets on every sign of life, it starts a single flat
  timer sized off the *whole job* up front and never touches it again.
  That can't tell "pulsing normally on a slow job" from "wedged": a
  healthy job that runs a bit long gets killed just as dead as a
  stalled one, and a real stall isn't caught within one pulse interval
  of starting - only whenever that same flat deadline happens to
  expire, however long that turns out to be.

## Your task

Fix both:

- `DoWork` must pulse on `heartbeat` throughout each unit's work, not
  just once at startup, while still respecting `done` (stop promptly
  instead of blocking forever trying to send on a channel nobody is
  receiving from).
- `WorkWithTimeout` must select on `heartbeat`, `results`, AND a timer
  that gets reset to `perPulseTimeout` on every heartbeat or result
  received - returning a non-nil error the moment `perPulseTimeout`
  elapses with neither, instead of waiting for however long the
  stalled unit would otherwise have taken.

Signatures stay the same:

```go
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int)
func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error)
```

`stallAfter < 0` or `stallAfter >= workUnits` means "no stall, run
normally" - use that as your normal-path case. A `stallAfter` in range
configures the work unit at that (0-based) index to simulate a worker
wedged on something unresponsive: see `mockworker.go`'s `SimulateUnit`
and `SetStallUnit` for exactly how that's modeled - once a unit stalls,
it never checks in again (no more heartbeats, no more results) until
it finally gives up, which - unless you catch it via the heartbeat -
takes a lot longer than any caller should have to wait.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
