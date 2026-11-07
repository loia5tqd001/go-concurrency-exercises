//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// guardTimeout limits a broken solution that blocks forever.
// It is longer than the slowest normal gateway call.
const guardTimeout = 5 * time.Second

// executeWithTimeout limits one Execute call.
// A broken lock can otherwise block this test forever.
func executeWithTimeout(t *testing.T, cb *CircuitBreaker, amountCents int) error {
	t.Helper()

	out := make(chan error, 1)
	go func() { out <- cb.Execute(amountCents) }()

	select {
	case err := <-out:
		return err
	case <-time.After(guardTimeout):
		t.Fatalf("Execute(%d) did not return within %s - a broken CircuitBreaker must never block a caller forever", amountCents, guardTimeout)
		return nil
	}
}

// waitWithTimeout limits wg.Wait().
// A worker stuck in Execute would otherwise hang the test.
func waitWithTimeout(t *testing.T, wg *sync.WaitGroup, timeout time.Duration) {
	t.Helper()

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("wg.Wait() did not return within %s - a goroutine is likely stuck inside a self-deadlocked Execute", timeout)
	}
}

// TestCircuitOpensAfterThreshold checks the 5-failure limit.
// The sixth call must fail fast without using the gateway.
func TestCircuitOpensAfterThreshold(t *testing.T) {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	gateway.SetFailing(true)

	for i := 1; i <= 5; i++ {
		err := cb.Execute(100)
		if !errors.Is(err, ErrGatewayDown) {
			t.Fatalf("call %d: expected ErrGatewayDown, got %v", i, err)
		}
	}

	if got := gateway.Calls(); got != 5 {
		t.Fatalf("expected gateway to have been called 5 times, got %d", got)
	}

	// The open breaker must reject the sixth call.
	err := cb.Execute(100)
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen on 6th call, got %v", err)
	}

	if got := gateway.Calls(); got != 5 {
		t.Fatalf("expected gateway to still have been called only 5 times (fail-fast), got %d", got)
	}
}

// TestCircuitHalfOpenRecovery checks the cooldown and trial call.
// A successful trial must close the breaker again.
func TestCircuitHalfOpenRecovery(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gateway := NewPaymentGateway()
		cb := NewCircuitBreaker(gateway)

		gateway.SetFailing(true)

		for i := 1; i <= 5; i++ {
			_ = cb.Execute(100)
		}

		// Check that the breaker is open.
		if err := cb.Execute(100); !errors.Is(err, ErrCircuitOpen) {
			t.Fatalf("expected breaker to be open, got %v", err)
		}

		// Recover the gateway and pass the cooldown.
		gateway.SetFailing(false)
		time.Sleep(2*time.Second + 10*time.Millisecond)

		// The trial call should succeed and close the breaker.
		if err := cb.Execute(100); err != nil {
			t.Fatalf("expected half-open trial call to succeed, got %v", err)
		}

		// Later calls should also use the gateway.
		for i := 0; i < 3; i++ {
			if err := cb.Execute(100); err != nil {
				t.Fatalf("expected breaker to be closed after recovery, got %v", err)
			}
		}
	})
}

// TestCircuitClosedDoesNotSerializeOnGatewayCall checks gateway calls.
// The breaker must release its lock before a slow gateway call.
// Otherwise two callers wait in line, and the breaker adds load.
// This test uses real time because synctest ignores mutex waits.
func TestCircuitClosedDoesNotSerializeOnGatewayCall(t *testing.T) {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	const delay = 150 * time.Millisecond
	gateway.SetDelay(delay)

	start := time.Now()
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			_ = cb.Execute(100)
		}()
	}
	waitWithTimeout(t, &wg, guardTimeout)
	elapsed := time.Since(start)

	// Concurrent calls take about one delay.
	// Serialized calls take about two delays.
	if elapsed >= delay*3/2 {
		t.Fatalf("two concurrent Closed-state calls took %v (gateway delay %v) - the breaker appears to serialize callers behind its own lock instead of releasing it during the gateway call", elapsed, delay)
	}
}

// TestCircuitHalfOpenTrialFailsFastForOthers checks the trial slot.
// Other callers must get ErrCircuitOpen while the trial runs.
// They must not wait on the breaker lock.
func TestCircuitHalfOpenTrialFailsFastForOthers(t *testing.T) {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	gateway.SetFailing(true)
	for i := 1; i <= 5; i++ {
		_ = cb.Execute(100)
	}

	gateway.SetFailing(false)
	const delay = 150 * time.Millisecond
	gateway.SetDelay(delay)
	time.Sleep(2*time.Second + 10*time.Millisecond)

	var trialErr error
	trialDone := make(chan struct{})
	go func() {
		trialErr = cb.Execute(100)
		close(trialDone)
	}()

	// Let the trial take the slot and start its slow call.
	time.Sleep(delay / 3)

	secondStart := time.Now()
	secondErr := executeWithTimeout(t, cb, 100)
	secondElapsed := time.Since(secondStart)

	if !errors.Is(secondErr, ErrCircuitOpen) {
		t.Fatalf("expected concurrent call during the half-open trial to get ErrCircuitOpen, got %v", secondErr)
	}
	if secondElapsed >= delay/2 {
		t.Fatalf("concurrent call during the half-open trial took %v to fail fast (gateway delay %v) - it was likely blocked on the breaker's own lock instead of being rejected immediately", secondElapsed, delay)
	}

	select {
	case <-trialDone:
	case <-time.After(guardTimeout):
		t.Fatalf("half-open trial call did not return within %s - the trial goroutine is likely stuck on the breaker's own lock", guardTimeout)
	}
	if trialErr != nil {
		t.Fatalf("expected the half-open trial call to succeed, got %v", trialErr)
	}
}

// TestCircuitConcurrentSafety calls Execute from many goroutines.
// Run it with `go test -race`.
func TestCircuitConcurrentSafety(t *testing.T) {
	gateway := NewPaymentGateway()
	cb := NewCircuitBreaker(gateway)

	gateway.SetFailing(true)

	const numGoroutines = 50

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			_ = cb.Execute(100)
		}()
	}

	waitWithTimeout(t, &wg, guardTimeout)

	// The gateway cannot receive more calls than the test launched.
	if got := gateway.Calls(); got > numGoroutines {
		t.Fatalf("gateway called more times (%d) than goroutines launched (%d)", got, numGoroutines)
	}
}
