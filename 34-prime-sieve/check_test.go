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

// TestPrimesReturnsCorrectPrimes checks that Primes(n) returns exactly
// the first n primes, in order. This passes against the naive
// implementation too - the sieve itself always computes the right
// answer; the bug in this exercise is entirely about what's left
// running afterward, not about the correctness of the returned values.
func TestPrimesReturnsCorrectPrimes(t *testing.T) {
	want := []int{2, 3, 5, 7, 11, 13, 17, 19, 23, 29}

	got := Primes(len(want))
	if len(got) != len(want) {
		t.Fatalf("Primes(%d) returned %d primes, want %d: %v", len(want), len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Primes(%d)[%d] = %d, want %d (got %v)", len(want), i, got[i], want[i], got)
		}
	}
}

// numGoroutinesToSettle polls runtime.NumGoroutine() until it drops to
// (or below) a threshold, or a deadline passes, and returns whatever
// it last observed. A correct implementation's stages unwind within a
// few scheduler ticks of their done channel closing; a leaked
// goroutine is blocked forever, not "not yet stopped", so this never
// masks the actual bug - it only keeps a correct solution from flaking
// under a slow scheduler.
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

// TestPrimesDoesNotLeakGoroutines is the key test. Every call to
// Primes(n) builds a chain of n+1 goroutines (one generate, n
// filters). Once the caller has its n primes, none of them should
// still be running - but the naive implementation wires every stage up
// with a nil done channel, so none of them can ever be told to stop:
// they're all left blocked forever trying to send a value nobody will
// ever read again.
func TestPrimesDoesNotLeakGoroutines(t *testing.T) {
	before := runtime.NumGoroutine()

	const n = 50
	got := Primes(n)
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

// TestPrimesRepeatedCallsDoNotAccumulateGoroutines calls Primes
// several times in a row and checks that the goroutine count stays
// flat across calls, rather than climbing with every call - the same
// leak as above, just piled up until it's impossible to miss.
func TestPrimesRepeatedCallsDoNotAccumulateGoroutines(t *testing.T) {
	before := runtime.NumGoroutine()

	const calls = 5
	for i := 0; i < calls; i++ {
		Primes(30)
	}

	after := numGoroutinesToSettle(before+3, 500*time.Millisecond)
	if after > before+3 {
		t.Errorf("goroutine count went from %d to %d after %d calls to Primes "+
			"(want it back near %d) - each call appears to leak its entire "+
			"generate/filter chain instead of shutting it down when it's done "+
			"with it", before, after, calls, before)
	}
}
