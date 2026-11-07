//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"runtime"
	"testing"
	"time"
)

// A call to Primes must return within this time.
// A wrong shutdown order can deadlock the whole chain.
const primesTimeout = 2 * time.Second

// primesWithTimeout fails fast if Primes does not return.
func primesWithTimeout(t *testing.T, n int) []int {
	t.Helper()

	resultCh := make(chan []int, 1)
	go func() {
		resultCh <- Primes(n)
	}()

	select {
	case got := <-resultCh:
		return got
	case <-time.After(primesTimeout):
		t.Fatalf("Primes(%d) did not return within %s", n, primesTimeout)
		return nil
	}
}

// Primes must return the first n primes in order.
// This passes even though the scaffold leaks goroutines.
func TestPrimesReturnsCorrectPrimes(t *testing.T) {
	want := []int{2, 3, 5, 7, 11, 13, 17, 19, 23, 29}

	got := primesWithTimeout(t, len(want))
	if len(got) != len(want) {
		t.Fatalf("Primes(%d) returned %d primes, want %d: %v", len(want), len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Primes(%d)[%d] = %d, want %d (got %v)", len(want), i, got[i], want[i], got)
		}
	}
}

// numGoroutinesToSettle waits for the count to reach a threshold.
// It returns the last count it observed.
func numGoroutinesToSettle(threshold int, timeout time.Duration) int {
	deadline := time.Now().Add(timeout)
	for {
		n := runtime.NumGoroutine()
		if n <= threshold || time.Now().After(deadline) {
			return n
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Primes(n) starts n+1 goroutines.
// All of them must stop before the call returns.
func TestPrimesDoesNotLeakGoroutines(t *testing.T) {
	before := runtime.NumGoroutine()

	const n = 50
	got := primesWithTimeout(t, n)
	if len(got) != n {
		t.Fatalf("Primes(%d) returned %d primes, want %d", n, len(got), n)
	}

	after := numGoroutinesToSettle(before+3, 500*time.Millisecond)
	if after > before+3 {
		t.Errorf("goroutine count went from %d to %d after Primes(%d) returned "+
			"(want it back near %d) - looks like the generate/filter chain was "+
			"never told to stop and is still running in the background", before, after, n, before)
	}
}

// Repeated calls must not increase the goroutine count.
func TestPrimesRepeatedCallsDoNotAccumulateGoroutines(t *testing.T) {
	before := runtime.NumGoroutine()

	const calls = 5
	for i := 0; i < calls; i++ {
		primesWithTimeout(t, 30)
	}

	after := numGoroutinesToSettle(before+3, 500*time.Millisecond)
	if after > before+3 {
		t.Errorf("goroutine count went from %d to %d after %d calls to Primes "+
			"(want it back near %d) - each call appears to leak its entire "+
			"generate/filter chain instead of shutting it down when it's done "+
			"with it", before, after, calls, before)
	}
}
