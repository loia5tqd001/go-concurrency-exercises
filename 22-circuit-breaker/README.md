# Protect a Flaky Payment Gateway with a Circuit Breaker

`CircuitBreaker` wraps calls to a flaky `PaymentGateway` (see
`mockgateway.go`). The gateway sometimes fails for a while. Today,
`CircuitBreaker` does not remember past calls:

```
caller ──▶ Execute ──▶ gateway.Charge ──▶ result
```

Every call goes straight to the gateway. This happens even after many
failures. A down gateway makes every caller wait. It also gets extra
load while it is already weak.

Turn `Execute` into a three-state breaker. It must be safe for
concurrent calls:

```
 CLOSED
   │  5 consecutive failures
   ▼
  OPEN
   │  cooldown (2s) elapses
   ▼
HALF-OPEN ──── trial succeeds ────▶ CLOSED (fail counter reset to 0)
   │
   └──── trial fails, cooldown restarts ────▶ OPEN
```

- **Closed** (initial state): calls go to `gateway.Charge`. Each failure
  adds one to the consecutive-failure count. A success resets the count
  to 0. After **5 consecutive failures**, the breaker moves to **Open**.
- **Open**: calls fail at once with `ErrCircuitOpen`. They do not call
  the gateway. This lasts for a **2 second** cooldown. After the
  cooldown, the breaker moves to **Half-Open**.
- **Half-Open**: one trial call may reach the gateway. Other callers get
  `ErrCircuitOpen` while it runs. A success moves the breaker to
  **Closed** and resets the failure count to 0. A failure moves it back
  to **Open**, and a new cooldown starts.

Keep the signatures the same:

```go
func NewCircuitBreaker(gateway *PaymentGateway) *CircuitBreaker
func (cb *CircuitBreaker) Execute(amountCents int) error
```

Add unexported state for the current state, failure count, and cooldown
deadline. Export a sentinel `var ErrCircuitOpen = errors.New(...)`.
Callers can check it with `errors.Is`.

## Test your solution

The tests must pass:
```
go test
go test --race
```
