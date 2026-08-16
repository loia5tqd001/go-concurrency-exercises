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

// guardTimeout bounds every blocking join or Execute call below that a
// self-deadlocking solution could otherwise hang forever - e.g. a
// non-reentrant sync.Mutex locked twice on the same goroutine, or a
// buffered channel used as a semaphore that's never drained back on
// some code path. Without a guard, that kind of bug turns one broken
// submission into a 10-minute `go test` timeout with no useful
// message instead of a fast, clear failure. It's set well above the
// slowest legitimate wait in this file (the 150ms gateway delay) so it
// can never mask a real timing assertion.
const guardTimeout = 5 * time.Second

// executeWithTimeout bounds a call to cb.Execute itself, not just
// anything it might return - a solution that deadlocks on its own
// lock while handling this call would otherwise block the calling
// goroutine forever.
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

// waitWithTimeout bounds a sync.WaitGroup.Wait() call. If any
// goroutine that owes wg.Done() is instead stuck inside a
// self-deadlocked Execute, a bare wg.Wait() would hang for the rest of
// the test run - this turns that into a fast, clear failure instead.
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

// TestCircuitOpensAfterThreshold checks that the breaker passes
// failures straight through to the gateway while closed, but trips to
// Open and starts fail-fasting (without touching the gateway at all)
// once 5 consecutive failures have been observed.
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

	// The 6th call should now be failed fast by the open breaker,
	// without ever reaching the gateway.
	err := cb.Execute(100)
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen on 6th call, got %v", err)
	}

	if got := gateway.Calls(); got != 5 {
		t.Fatalf("expected gateway to still have been called only 5 times (fail-fast), got %d", got)
	}
}

// TestCircuitHalfOpenRecovery checks that after the cooldown elapses
// the breaker allows a trial call through (Half-Open), and that a
// success there fully recovers the breaker back to Closed rather than
// leaving it stuck.
func TestCircuitHalfOpenRecovery(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gateway := NewPaymentGateway()
		cb := NewCircuitBreaker(gateway)

		gateway.SetFailing(true)

		for i := 1; i <= 5; i++ {
			_ = cb.Execute(100)
		}

		// Confirm it's actually open now.
		if err := cb.Execute(100); !errors.Is(err, ErrCircuitOpen) {
			t.Fatalf("expected breaker to be open, got %v", err)
		}

		// Gateway recovers, and we wait past the 2s cooldown.
		gateway.SetFailing(false)
		time.Sleep(2*time.Second + 10*time.Millisecond)

		// The trial (half-open) call should now go through and
		// succeed, closing the breaker again.
		if err := cb.Execute(100); err != nil {
			t.Fatalf("expected half-open trial call to succeed, got %v", err)
		}

		// Breaker should be fully closed now, not stuck half-open:
		// further calls should succeed normally too.
		for i := 0; i < 3; i++ {
			if err := cb.Execute(100); err != nil {
				t.Fatalf("expected breaker to be closed after recovery, got %v", err)
			}
		}
	})
}

// TestCircuitClosedDoesNotSerializeOnGatewayCall checks that the
// breaker's own lock isn't held across the (potentially slow) call to
// the wrapped gateway. If it were, two callers arriving while the
// circuit is Closed and the gateway happens to be slow would be
// serialized behind the breaker itself - exactly the kind of
// bottleneck a circuit breaker is supposed to prevent, not cause.
//
// This uses real wall-clock timing rather than testing/synctest:
// synctest's fake clock only advances once every goroutine in the
// bubble is "durably blocked", and per its own docs, blocking on a
// sync.Mutex does NOT count as durably blocked. A buggy
// lock-held-across-the-call implementation would leave one goroutine
// merely blocked on cb.mu while the other sleeps inside the bubble,
// which never satisfies synctest's all-durably-blocked condition -
// so the test would hang instead of failing.
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

	// Run concurrently: ~1x delay. Serialized behind the breaker's own
	// lock: ~2x delay. The threshold sits well in between.
	if elapsed >= delay*3/2 {
		t.Fatalf("two concurrent Closed-state calls took %v (gateway delay %v) - the breaker appears to serialize callers behind its own lock instead of releasing it during the gateway call", elapsed, delay)
	}
}

// TestCircuitHalfOpenTrialFailsFastForOthers checks that while the
// single Half-Open trial call is in flight, a concurrent caller is
// rejected immediately with ErrCircuitOpen rather than blocking until
// the trial finishes. Blocking instead of failing fast would mean the
// breaker's own lock is held across the trial's gateway call, which
// defeats the fail-fast guarantee Open/Half-Open is supposed to give
// every other caller.
//
// Real wall-clock timing is used for the same reason as
// TestCircuitClosedDoesNotSerializeOnGatewayCall: the failure mode
// this test targets is a goroutine stuck on cb.mu, which
// testing/synctest cannot recognize as blocked.
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

	// Give the trial goroutine time to claim the half-open slot and
	// start its (slow) call to the gateway, without waiting for it to
	// finish.
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

// TestCircuitConcurrentSafety hammers Execute from many goroutines at
// once while the gateway is failing, to catch data races on the
// breaker's internal state (run with `go test -race`).
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

	// Loose, non-flaky sanity bound: the gateway can never have been
	// hit more often than the number of callers.
	if got := gateway.Calls(); got > numGoroutines {
		t.Fatalf("gateway called more times (%d) than goroutines launched (%d)", got, numGoroutines)
	}
}
