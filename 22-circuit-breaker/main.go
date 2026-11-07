//////////////////////////////////////////////////////////////////////
//
// CircuitBreaker wraps a flaky payment gateway.
// The current code sends every call to the gateway.
// When the gateway is down, that adds more load and slows every caller.
//
// Your task is to build a circuit breaker:
//   - Closed: pass calls through.
//     Reset the failure count on success.
//     Open after 5 failures in a row.
//   - Open: return ErrCircuitOpen for 2 seconds.
//     Then allow one trial call.
//   - Half-Open: allow one call.
//     Success closes the breaker.
//     Failure reopens it and restarts the wait.
//
// Keep the type and Execute signature.
// Add private state for the failure count and cooldown.
//

package main

import (
	"errors"
	"fmt"
)

// ErrCircuitOpen means the breaker rejected the call without using the gateway.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// CircuitBreaker wraps a PaymentGateway.
type CircuitBreaker struct {
	gateway *PaymentGateway
}

// NewCircuitBreaker wraps gateway.
func NewCircuitBreaker(gateway *PaymentGateway) *CircuitBreaker {
	return &CircuitBreaker{
		gateway: gateway,
	}
}

// Execute charges through the wrapped gateway.
func (cb *CircuitBreaker) Execute(amountCents int) error {
	return cb.gateway.Charge(amountCents)
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
