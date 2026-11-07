# Protect a flaky payment gateway with a circuit breaker

> **Spoiler warning.** This file has full solutions for `22-circuit-breaker/`. Try the exercise first. Come back if you get stuck.

## The problem

The starter `CircuitBreaker` wraps a flaky `PaymentGateway`. See `mockgateway.go`. It does no protection:

```go
type CircuitBreaker struct {
	gateway *PaymentGateway
}

func (cb *CircuitBreaker) Execute(amountCents int) error {
	return cb.gateway.Charge(amountCents)
}
```

`CircuitBreaker` must use the three-state pattern. It must be safe for concurrent calls:

- Closed is the first state. Calls go to `gateway.Charge`. A failure adds to a consecutive-failure count. A success resets the count to 0.
- After 5 consecutive failures, the breaker moves to Open.
- Open rejects calls at once with `ErrCircuitOpen`. It does not touch the gateway. This lasts for a 2-second cooldown.
- After the cooldown, the breaker moves to Half-Open. The code names these states `stateOpen` and `stateHalfOpen`.
- Half-Open lets in one trial call. Success returns to Closed and resets the failure count to 0.
- A failed trial returns to Open and starts a new cooldown.

Keep the `CircuitBreaker` type and `Execute(amountCents int) error` signature. Do not change the method.

Also provide `var ErrCircuitOpen = errors.New(...)`. Callers must be able to test it with `errors.Is`.

## Why the naive version is wrong

`Execute` only passes the call through. It never counts recent failures. It remembers no protection state.

- `CircuitBreaker` has only a `gateway` field. It has no state, failure count, or cooldown time.
- Every call reaches `gateway.Charge`, even after an hour of failures. A struggling service gets no rest.
- The code declares `ErrCircuitOpen`, but nothing returns it.

I ran `check_test.go` against the naive `main.go`. Three of five tests fail:

```
=== RUN   TestCircuitOpensAfterThreshold
    check_test.go:92: expected ErrCircuitOpen on 6th call, got payment gateway: connection down
--- FAIL: TestCircuitOpensAfterThreshold (0.00s)
=== RUN   TestCircuitHalfOpenRecovery
    check_test.go:117: expected breaker to be open, got payment gateway: connection down
--- FAIL: TestCircuitHalfOpenRecovery (0.00s)
=== RUN   TestCircuitClosedDoesNotSerializeOnGatewayCall
--- PASS: TestCircuitClosedDoesNotSerializeOnGatewayCall (0.15s)
=== RUN   TestCircuitHalfOpenTrialFailsFastForOthers
    check_test.go:224: expected concurrent call during the half-open trial to get ErrCircuitOpen, got <nil>
--- FAIL: TestCircuitHalfOpenTrialFailsFastForOthers (2.21s)
=== RUN   TestCircuitConcurrentSafety
--- PASS: TestCircuitConcurrentSafety (0.00s)
FAIL
```

`TestCircuitClosedDoesNotSerializeOnGatewayCall` and `TestCircuitConcurrentSafety` pass by accident.

The first passes because a pass-through holds no lock. It cannot serialize calls.

The second only checks a loose upper bound on gateway calls. A pass-through always meets that bound.

The whole suite fails in under 3 seconds. `check_test.go` puts a timeout around every blocking `Execute` wait.

It uses `waitWithTimeout` and `executeWithTimeout`. A self-deadlocking version fails instead of hanging the run.

## Approach 1: mutex-protected state machine

```go {53,54,79,80}
package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrCircuitOpen is returned by Execute when the circuit breaker is
// open (or half-open with its trial slot taken) and is fail-fasting
// without reaching the gateway.
var ErrCircuitOpen = errors.New("circuit breaker is open")

type circuitState int

const (
	stateClosed circuitState = iota
	stateOpen
	stateHalfOpen
)

const (
	failureThreshold = 5
	cooldownPeriod   = 2 * time.Second
)

// CircuitBreaker wraps a PaymentGateway and protects it from being
// hammered with load while it is failing, using the classic
// Closed -> Open -> Half-Open state machine.
type CircuitBreaker struct {
	gateway *PaymentGateway

	mu               sync.Mutex
	state            circuitState
	consecutiveFails int
	openedAt         time.Time
	halfOpenInFlight bool
}

// NewCircuitBreaker creates a new CircuitBreaker wrapping the given
// gateway.
func NewCircuitBreaker(gateway *PaymentGateway) *CircuitBreaker {
	return &CircuitBreaker{
		gateway: gateway,
		state:   stateClosed,
	}
}

// Execute attempts to charge amountCents through the wrapped gateway,
// applying circuit-breaker protection.
func (cb *CircuitBreaker) Execute(amountCents int) error {
	if !cb.allow() {
		return ErrCircuitOpen
	}

	err := cb.gateway.Charge(amountCents)
	cb.afterCall(err)
	return err
}

// allow decides, under lock, whether this call may proceed to the
// gateway. It also performs the Open -> Half-Open transition once the
// cooldown has elapsed, and reserves the single half-open trial slot.
func (cb *CircuitBreaker) allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case stateClosed:
		return true

	case stateOpen:
		if time.Since(cb.openedAt) < cooldownPeriod {
			return false
		}
		// Cooldown elapsed: move to half-open and let this call be
		// the single trial.
		cb.state = stateHalfOpen
		cb.halfOpenInFlight = true
		return true

	case stateHalfOpen:
		if cb.halfOpenInFlight {
			// Trial slot already taken; fail fast.
			return false
		}
		cb.halfOpenInFlight = true
		return true
	}

	return false
}

// afterCall records the outcome of a call that was allowed through to
// the gateway and updates the state machine accordingly.
func (cb *CircuitBreaker) afterCall(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case stateHalfOpen:
		cb.halfOpenInFlight = false
		if err == nil {
			cb.state = stateClosed
			cb.consecutiveFails = 0
		} else {
			cb.state = stateOpen
			cb.openedAt = time.Now()
		}

	default: // stateClosed (stateOpen can't reach here: allow() rejects it)
		if err == nil {
			cb.consecutiveFails = 0
		} else {
			cb.consecutiveFails++
			if cb.consecutiveFails >= failureThreshold {
				cb.state = stateOpen
				cb.openedAt = time.Now()
			}
		}
	}
}

func main() {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	gateway.SetFailing(true)

	for i := 1; i <= 6; i++ {
		err := cb.Execute(100)
		fmt.Println("call", i, "->", err)
	}

	fmt.Println("total calls that reached the gateway:", gateway.Calls())
}
```

Design notes:

- One mutex protects the whole state machine. `state`, `consecutiveFails`, `openedAt`, and `halfOpenInFlight` change only under `cb.mu`.
- This makes each transition one step. The code checks the counter, changes state, and records the deadline together.
- `allow()` acts as a gate and as the transition point. It changes Open to Half-Open and claims the trial slot under one lock.
- Two goroutines cannot both see the cooldown end and both take the trial.
- `Execute` calls `cb.gateway.Charge` outside the lock. It runs between `allow()` and `afterCall()`.
- Holding `cb.mu` during a slow network call would serialize all callers. Healthy traffic must still run at the same time.
- The `default` branch in `afterCall` relies on a rule. `allow()` returns `true` only for Closed or Half-Open calls. It never lets through Open.
- The `switch` separates a half-open trial from a normal closed call. No third case can reach it.

I tested this in a scratch copy. The naive `main.go` fails the three tests above. The solution passes `go test -race -count=5 ./...` with no flakes.

This includes `TestCircuitHalfOpenRecovery`, which uses `synctest.Test` and sleeps past the 2-second cooldown.

It also includes `TestCircuitHalfOpenTrialFailsFastForOthers`, which uses real time to catch a trial-slot leak.

`TestCircuitConcurrentSafety` calls `Execute` from 50 goroutines under `-race`.

## Approach 2: lock-free state machine with `sync/atomic` (alternative)

This uses different primitives. `state` and the failure counter are `int32`.

The cooldown deadline is an `int64` in Unix nanoseconds. The half-open trial guard is an `int32` flag.

Each field is an independent atomic. No `sync.Mutex` is used.

```go {71,74,102,103,104,118,119}
package main

import (
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

const (
	stateClosed int32 = iota
	stateOpen
	stateHalfOpen
)

const (
	failureThreshold = 5
	cooldownPeriod   = 2 * time.Second
)

// CircuitBreaker wraps a PaymentGateway and protects it from being
// hammered with load while it is failing, using the classic
// Closed -> Open -> Half-Open state machine. Unlike the mutex
// approach, every field here is an independent atomic - there is no
// single lock that makes a "state + counter + deadline" transition
// happen as one indivisible step, so every transition has to be built
// out of careful CAS ordering instead.
type CircuitBreaker struct {
	gateway *PaymentGateway

	state            int32 // atomic: stateClosed / stateOpen / stateHalfOpen
	consecutiveFails int32 // atomic
	openedAtNano     int64 // atomic: UnixNano() timestamp of the last trip to Open
	halfOpenInFlight int32 // atomic 0/1: guards the single half-open trial slot
}

func NewCircuitBreaker(gateway *PaymentGateway) *CircuitBreaker {
	return &CircuitBreaker{gateway: gateway, state: stateClosed}
}

func (cb *CircuitBreaker) Execute(amountCents int) error {
	if !cb.allow() {
		return ErrCircuitOpen
	}
	err := cb.gateway.Charge(amountCents)
	cb.afterCall(err)
	return err
}

func (cb *CircuitBreaker) allow() bool {
	for {
		switch atomic.LoadInt32(&cb.state) {
		case stateClosed:
			return true

		case stateOpen:
			openedAt := atomic.LoadInt64(&cb.openedAtNano)
			if time.Since(time.Unix(0, openedAt)) < cooldownPeriod {
				return false
			}

			// Cooldown elapsed. Claim the trial slot BEFORE
			// publishing the Open -> Half-Open state change - if we
			// flipped cb.state first and only then set
			// halfOpenInFlight, a second goroutine could observe the
			// new stateHalfOpen with the flag still at its old value
			// and believe it, too, had claimed the trial slot,
			// handing out two "single" trials at once.
			if !atomic.CompareAndSwapInt32(&cb.halfOpenInFlight, 0, 1) {
				continue // someone else is already mid-transition; retry
			}
			if !atomic.CompareAndSwapInt32(&cb.state, stateOpen, stateHalfOpen) {
				atomic.StoreInt32(&cb.halfOpenInFlight, 0)
				continue
			}
			return true

		case stateHalfOpen:
			if atomic.CompareAndSwapInt32(&cb.halfOpenInFlight, 0, 1) {
				return true
			}
			return false // trial slot already taken
		}
	}
}

func (cb *CircuitBreaker) afterCall(err error) {
	switch atomic.LoadInt32(&cb.state) {
	case stateHalfOpen:
		if err == nil {
			atomic.StoreInt32(&cb.consecutiveFails, 0)
			atomic.StoreInt32(&cb.state, stateClosed)
			atomic.StoreInt32(&cb.halfOpenInFlight, 0)
		} else {
			// Publish the new deadline and state BEFORE releasing the
			// flag - releasing first would let a racing caller see
			// stateHalfOpen with the flag already free and grab a
			// brand new "trial" before the breaker has actually
			// finished re-opening.
			atomic.StoreInt64(&cb.openedAtNano, time.Now().UnixNano())
			atomic.StoreInt32(&cb.state, stateOpen)
			atomic.StoreInt32(&cb.halfOpenInFlight, 0)
		}

	default: // stateClosed
		if err == nil {
			atomic.StoreInt32(&cb.consecutiveFails, 0)
			return
		}
		fails := atomic.AddInt32(&cb.consecutiveFails, 1)
		if fails >= failureThreshold {
			// Same ordering concern: set the deadline before the
			// state that makes it visible, so nobody can observe
			// stateOpen next to a stale (or zero-value) openedAtNano
			// and wrongly conclude the cooldown already elapsed.
			atomic.StoreInt64(&cb.openedAtNano, time.Now().UnixNano())
			atomic.CompareAndSwapInt32(&cb.state, stateClosed, stateOpen)
		}
	}
}

func main() {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	gateway.SetFailing(true)

	for i := 1; i <= 6; i++ {
		err := cb.Execute(100)
		fmt.Println("call", i, "->", err)
	}

	fmt.Println("total calls that reached the gateway:", gateway.Calls())
}
```

Design notes and tradeoffs:

- This version is harder to get right. That is the main lesson.
- A mutex makes "check cooldown, change state, set deadline" one critical section. No goroutine sees half a transition.
- Independent atomics need a manual write order. A goroutine must not see new `state` before `openedAtNano`.
- It must not see a free trial flag before the guarded state settles.
- The three comments in `allow` and `afterCall` mark these ordering points.
- A reversed write order can create a second trial or an early Half-Open move.
- `go test -race` may miss these logic bugs. It finds conflicting memory access, not bad ordering between atomics.
- The `for { ... continue }` loop retries instead of blocking. `allow()` never sleeps or parks.
- When the cooldown ends and callers compete, a goroutine reads again and retries.
- That window is small, but this is a busy-wait. A waiter in `sync.Mutex.Lock` yields the CPU.
- All compound transitions use store-before-publish order.
- Set the deadline before state, claim the flag before changing state, and settle state before releasing the flag.
- These rules close the gaps a simple atomic port would have.
- They need three separate, easy-to-miss decisions. A mutex needs none of them.
- Atomics avoid lock contention and OS wakeups. This can help at very high call rates.
- Here, `allow()` and `afterCall()` are cheap. The common `stateClosed` path has no contention.
- `gateway.Charge` runs outside either lock. The mutex version is usually the better default.
- Use atomics only when profiling shows lock contention on the breaker.

I tested this in the same scratch copy. I replaced the mutex version with this code. `go build ./...` is clean.

`go test -race -count=5 ./...` passed with no flakes. It covered the same tests, including the `synctest` recovery test, the real-time trial test, and the 50-goroutine safety test.

## Key takeaways

- A breaker's state is one compound value. It includes phase, failure count, cooldown, and trial guard.
- Every transition changes several fields together. A mutex gives that atomicity for free.
- Keep the slow wrapped-service call outside the lock. Hold the breaker lock only for `allow` and `afterCall`.
- Holding it during `gateway.Charge` makes the breaker the new bottleneck.
- `sync/atomic` can replace the mutex only with careful publish order.
- Set deadline before state, claim the flag before state change, and settle state before flag release.
- One reversed step opens the race a mutex closes.
- `-race` will not find this bug because the problem is operation order, not raw unsynchronized access.
- For a small, low-contention state machine, prefer the mutex. A `Lock()` and `Unlock()` pair is easier to read, review, and prove.
- Use atomics only when measurements show a reason.
