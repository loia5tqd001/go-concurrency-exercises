//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"testing"
	"time"
)

// dineWithTimeout runs Dine and returns after a real-time limit.
// We do not use synctest here.
// synctest panics on a deadlock and would fail the whole file.
// A plain goroutine lets this test fail cleanly in one place.
func dineWithTimeout(t *testing.T, numPhilosophers, mealsToEat int, timeout time.Duration) int32 {
	t.Helper()

	done := make(chan int32, 1)
	go func() {
		done <- Dine(numPhilosophers, mealsToEat)
	}()

	select {
	case total := <-done:
		return total
	case <-time.After(timeout):
		t.Fatalf("dinner did not complete within %s - either philosophers are deadlocked "+
			"waiting on forks, or this valid-but-slow solution exceeded the test budget", timeout)
		return 0
	}
}

// TestDineCompletesWithoutDeadlock uses many meals.
// The scaffold pause makes a bad fix deadlock again and again.
// A correct fix still finishes within the test limit.
func TestDineCompletesWithoutDeadlock(t *testing.T) {
	const numPhilosophers = 5
	const mealsToEat = 250

	total := dineWithTimeout(t, numPhilosophers, mealsToEat, 3*time.Second)

	want := int32(numPhilosophers * mealsToEat)
	if total != want {
		t.Errorf("Dine(%d, %d) = %d meals eaten, want %d", numPhilosophers, mealsToEat, total, want)
	}
}

// TestDineWithVaryingTableSizes checks small and larger tables.
// The fix must not depend on one table size.
func TestDineWithVaryingTableSizes(t *testing.T) {
	const mealsToEat = 5

	for _, numPhilosophers := range []int{2, 5, 8} {
		numPhilosophers := numPhilosophers
		t.Run("", func(t *testing.T) {
			total := dineWithTimeout(t, numPhilosophers, mealsToEat, 2*time.Second)

			want := int32(numPhilosophers * mealsToEat)
			if total != want {
				t.Errorf("Dine(%d, %d) = %d meals eaten, want %d", numPhilosophers, mealsToEat, total, want)
			}
		})
	}
}

// Run with `go test -race` too.
