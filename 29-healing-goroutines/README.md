# Healing Unhealthy Goroutines: A Steward That Restarts a Wedged Ward

`NewSteward` should watch a long-running ward goroutine. It uses
heartbeats to check that the ward is alive. If the ward is silent for
too long, the steward should restart it. Today, it does not do this.
See `mockward.go` for the test double.

A ward is any goroutine matching this shape:

```go
type StartGoroutineFn func(done <-chan struct{}, pulseInterval time.Duration) (heartbeat <-chan struct{})
```

Starting a ward gives it a `done` channel and a `pulseInterval`. The
ward sends heartbeats at that interval on its returned `heartbeat`
channel.

A real ward can stop responding. It may hang or deadlock. It may
ignore `done` and never exit. If the ward goes silent, the steward's
heartbeats also stop today.

```
TODAY (scaffold): 1 ward generation, no monitor goroutine, no timer

  caller ──done──▶ steward ──same done──▶ ward gen 1
                     ◀──── heartbeat ──────┘  (handed back as-is)

  pulses: 1 2 3 4 ── wedge ──▶ silent forever, steward included


GOAL (fixed): 1 steward monitor goroutine, fresh done per generation
              e.g. timeout 350ms, pulseInterval 100ms, wedge after 5

  caller ──done──▶ steward ──fresh done──▶ ward gen 1
                     ◀──── heartbeat ──────┘
                                   │
                     350ms with no pulse since the last forwarded one
                                   ▼
                close gen 1's done (no wait), start gen 2
                                   │
                                   ▼  gen 2's first pulse, 100ms later
  pulses: 1 2 3 4 5 ─ wedge ─▶ 450ms of silence ─▶ 1 2 3 4 5 ─▶ ... and on
  steward keeps pulsing across every restart; caller's done ends it
```

Implement `NewSteward` so it monitors and heals the ward it wraps:

```go
func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn
```

`NewSteward` returns a `StartGoroutineFn`. A steward has the same shape
as the thing it watches. Stewards can therefore wrap other stewards.
When the returned function is called with `(done, pulseInterval)`, it
must:

- Start a ward generation with `ward(wardDone, pulseInterval)`. Use a
  fresh `wardDone` owned by the steward. Never pass the steward's own
  `done` straight to the ward.
- Forward the current ward's heartbeats to the steward's output. A slow
  caller must not block health checks. It is fine to merge pending
  pulses.
- Track time since the last pulse. If more than `timeout` passes with no
  pulse, close that generation's `wardDone`. Do not wait for a stuck
  ward. Start a new generation at once with a fresh `wardDone`. Keep
  forwarding its pulses.
- When the steward's own `done` closes, close the current `wardDone` and
  stop. Do not send more heartbeats.

## The mock ward

`mockward.go` (do not edit) provides a `MockWard` used in
`check_test.go`:

```go
func NewMockWard(pulsesBeforeWedge int) *MockWard
func (w *MockWard) Start(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{}
func (w *MockWard) Generations() int
func (w *MockWard) Dones() []<-chan struct{}
```

`(*MockWard).Start` has the shape of `StartGoroutineFn`. You can pass it
to `NewSteward(timeout, ward.Start)`.

Each generation sends normal pulses. Then it goes silent at
`pulsesBeforeWedge`. It ignores `done` for the rest of that generation.
This simulates a deadlock.

`Generations()` returns the number of ward generations started. A test
or `main` can use it to confirm a real restart. `Dones()` returns each
generation's `done` channel in start order. Use it to confirm each
generation has its own steward-owned `wardDone`.

## Test your solution

The tests must pass:
```
go test
go test --race
```
