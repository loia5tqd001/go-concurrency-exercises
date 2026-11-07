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

// testPerPulseTimeout is longer than workerPulseInterval.
const testPerPulseTimeout = 300 * time.Millisecond

// TestNoStallCompletesSuccessfully checks a healthy slow job.
func TestNoStallCompletesSuccessfully(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const workUnits = 5

		res, err := WorkWithTimeout(workUnits, -1, testPerPulseTimeout)
		if err != nil {
			t.Fatalf("expected nil error for a normal run, got %v", err)
		}

		if len(res) != workUnits {
			t.Fatalf("expected %d results, got %d: %v", workUnits, len(res), res)
		}

		for i, v := range res {
			if v != i {
				t.Errorf("res[%d] = %d, want %d", i, v, i)
			}
		}
	})
}

// TestStallDetectedPromptly stalls unit 2.
// One quiet timeout should report the stall.
// The stalled unit itself would wait for 24 hours.
func TestStallDetectedPromptly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const (
			workUnits  = 5
			stallAfter = 2
		)

		start := time.Now()
		res, err := WorkWithTimeout(workUnits, stallAfter, testPerPulseTimeout)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("expected a non-nil error once the worker stalled, got nil (results: %v)", res)
		}

		// The stall cannot be detected before unit 2 starts.
		stallStartsAt := 2 * UnitDuration
		if elapsed < stallStartsAt {
			t.Fatalf("detected a stall before unit %d even started: elapsed %s, unit %d starts at %s",
				stallAfter, elapsed, stallAfter, stallStartsAt)
		}

		// Detection must happen soon after the first quiet timeout.
		deadline := stallStartsAt + testPerPulseTimeout + 2*workerPulseInterval
		if elapsed > deadline {
			t.Fatalf("did not detect the stall promptly: took %s, want at most %s "+
				"(stall starts at %s + one perPulseTimeout of %s)",
				elapsed, deadline, stallStartsAt, testPerPulseTimeout)
		}
	})
}

// TestConcurrentSafety runs many healthy jobs at once.
// Every caller uses the same shared stall setting without changing it.
// Run with `go test -race`.
func TestConcurrentSafety(t *testing.T) {
	const (
		callers   = 20
		workUnits = 3
	)

	var wg sync.WaitGroup
	wg.Add(callers)

	errs := make([]error, callers)

	for i := 0; i < callers; i++ {
		go func(i int) {
			defer wg.Done()

			res, err := WorkWithTimeout(workUnits, -1, testPerPulseTimeout)
			if err == nil && len(res) != workUnits {
				err = errors.New("unexpected result count from a non-stalling run")
			}
			errs[i] = err
		}(i)
	}

	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("caller %d: %v", i, err)
		}
	}
}
