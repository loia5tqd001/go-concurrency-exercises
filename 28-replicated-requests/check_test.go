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

// callTimeout limits direct FetchFastest calls.
// A cancelled replica can still block a broken implementation.
const callTimeout = 2 * time.Second

// fetchFastestWithTimeout limits how long FetchFastest may take.
func fetchFastestWithTimeout(t *testing.T, done <-chan struct{}, replicas ...Replica) (string, error) {
	t.Helper()

	type outcome struct {
		value string
		err   error
	}
	out := make(chan outcome, 1)
	go func() {
		value, err := FetchFastest(done, replicas...)
		out <- outcome{value, err}
	}()

	select {
	case o := <-out:
		return o.value, o.err
	case <-time.After(callTimeout):
		t.Fatalf("FetchFastest did not return within %s - looks wedged", callTimeout)
		return "", nil
	}
}

// TestFetchFastestReturnsFastestValue checks the fastest result.
// It also checks that every losing replica sees cancellation.
// The fake clock keeps both timing checks stable.
func TestFetchFastestReturnsFastestValue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fast := NewMockReplica("fast", 10*time.Millisecond)
		slow1 := NewMockReplica("slow1", 100*time.Millisecond)
		slow2 := NewMockReplica("slow2", 200*time.Millisecond)
		slow3 := NewMockReplica("slow3", 300*time.Millisecond)

		done := make(chan struct{})

		start := time.Now()
		got, err := FetchFastest(done, fast.Replica, slow1.Replica, slow2.Replica, slow3.Replica)
		elapsed := time.Since(start)

		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "fast" {
			t.Fatalf("FetchFastest returned %q, want %q (the fastest replica's value)", got, "fast")
		}
		if elapsed >= 50*time.Millisecond {
			t.Errorf("FetchFastest took %s, want close to the fastest replica's 10ms latency, "+
				"not the slower replicas' latency too", elapsed)
		}

		// Give the losers a short fake-time moment to react.
		time.Sleep(5 * time.Millisecond)

		for _, loser := range []*MockReplica{slow1, slow2, slow3} {
			if !loser.ObservedCancellation() {
				t.Errorf("replica %q never observed its done channel being closed - "+
					"it is going to keep running all the way to its full artificial "+
					"latency instead of stopping as soon as it lost the race", loser.name)
			}
			if loser.RanToCompletion() {
				t.Errorf("replica %q ran to completion instead of being cancelled early", loser.name)
			}
		}

		// Let leaked goroutines finish before synctest checks the bubble.
		time.Sleep(400 * time.Millisecond)
	})
}

// TestFetchFastestReturnsWinnerError checks the winning error.
func TestFetchFastestReturnsWinnerError(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		wantErr := errors.New("boom")
		fast := NewMockReplica("fast", 10*time.Millisecond).WithError(wantErr)
		slow := NewMockReplica("slow", 100*time.Millisecond)

		done := make(chan struct{})

		got, err := FetchFastest(done, fast.Replica, slow.Replica)

		if got != "fast" {
			t.Fatalf("FetchFastest returned %q, want %q (the fastest replica's value)", got, "fast")
		}
		if !errors.Is(err, wantErr) {
			t.Fatalf("FetchFastest returned err=%v, want the fastest replica's own error %v - "+
				"the winner's error must be returned alongside its value, not discarded", err, wantErr)
		}

		// Let the loser react before synctest checks the bubble.
		time.Sleep(150 * time.Millisecond)
	})
}

// TestFetchFastestClosedDoneCancelsEarly checks caller cancellation.
// It must return an error with no winner.
// Every replica must also receive cancellation.
func TestFetchFastestClosedDoneCancelsEarly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r1 := NewMockReplica("a", 50*time.Millisecond)
		r2 := NewMockReplica("b", 100*time.Millisecond)

		done := make(chan struct{})
		close(done)

		start := time.Now()
		got, err := FetchFastest(done, r1.Replica, r2.Replica)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("expected an error when done is already closed before calling "+
				"FetchFastest, got value %q with nil error", got)
		}
		if got != "" {
			t.Errorf("expected no winner value when cancelled up front, got %q", got)
		}
		if elapsed >= 5*time.Millisecond {
			t.Errorf("FetchFastest took %s with an already-closed done, want a near-instant return", elapsed)
		}

		// Give the replicas a short fake-time moment to react.
		time.Sleep(5 * time.Millisecond)

		for _, r := range []*MockReplica{r1, r2} {
			if !r.ObservedCancellation() {
				t.Errorf("replica %q never observed its done channel being closed after the caller's "+
					"done fired with no winner - it is going to keep running all the way to its full "+
					"artificial latency instead of stopping as soon as the caller cancelled", r.name)
			}
			if r.RanToCompletion() {
				t.Errorf("replica %q ran to completion instead of being cancelled early", r.name)
			}
		}

		// Let leaked goroutines finish before synctest checks the bubble.
		time.Sleep(150 * time.Millisecond)
	})
}

// TestFetchFastestNoReplicas checks an empty replica list.
// It must return an error, not wait forever.
func TestFetchFastestNoReplicas(t *testing.T) {
	done := make(chan struct{})
	if _, err := fetchFastestWithTimeout(t, done); err == nil {
		t.Fatal("expected an error when no replicas are given, got nil")
	}
}

// TestFetchFastestConcurrentSafety runs many FetchFastest calls at once.
// Run it with `go test -race`.
// The final wait is limited because one broken call can hang.
func TestFetchFastestConcurrentSafety(t *testing.T) {
	const calls = 20

	var wg sync.WaitGroup
	wg.Add(calls)

	for i := 0; i < calls; i++ {
		go func() {
			defer wg.Done()

			r1 := NewMockReplica("x", 2*time.Millisecond)
			r2 := NewMockReplica("y", 5*time.Millisecond)
			r3 := NewMockReplica("z", 8*time.Millisecond)

			done := make(chan struct{})
			_, _ = fetchFastestWithTimeout(t, done, r1.Replica, r2.Replica, r3.Replica)
		}()
	}

	finished := make(chan struct{})
	go func() {
		wg.Wait()
		close(finished)
	}()

	select {
	case <-finished:
	case <-time.After(2 * callTimeout):
		t.Fatal("concurrent FetchFastest calls never completed - looks wedged")
	}
}
