//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"sync"
	"time"
)

// ErrGatewayDown means the mock gateway is failing.
var ErrGatewayDown = errors.New("payment gateway: connection down")

// PaymentGateway simulates a flaky payment service.
// Its methods are safe for concurrent use.
type PaymentGateway struct {
	mu      sync.Mutex
	failing bool
	calls   int
	delay   time.Duration
}

// NewPaymentGateway returns a healthy gateway.
func NewPaymentGateway() *PaymentGateway {
	return &PaymentGateway{}
}

// SetFailing controls whether Charge succeeds.
func (g *PaymentGateway) SetFailing(failing bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failing = failing
}

// Calls returns how many calls reached the gateway.
func (g *PaymentGateway) Calls() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

// SetDelay makes Charge wait for d.
func (g *PaymentGateway) SetDelay(d time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.delay = d
}

// Charge simulates a payment.
// It counts every call and returns ErrGatewayDown while failing.
func (g *PaymentGateway) Charge(amountCents int) error {
	g.mu.Lock()
	g.calls++
	delay := g.delay
	failing := g.failing
	g.mu.Unlock()

	if delay > 0 {
		time.Sleep(delay)
	}

	if failing {
		return ErrGatewayDown
	}
	return nil
}
