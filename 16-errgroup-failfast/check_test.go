//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// TestGroupRunsAllTasksToCompletion checks every task runs.
// Wait must return one of the task errors.
func TestGroupRunsAllTasksToCompletion(t *testing.T) {
	var g Group

	var mu sync.Mutex
	count := 0

	const n = 10
	failing := map[int]bool{2: true, 5: true, 8: true}
	expectedErrs := make(map[error]bool)

	for i := 0; i < n; i++ {
		i := i
		var taskErr error
		if failing[i] {
			taskErr = fmt.Errorf("task %d failed", i)
			expectedErrs[taskErr] = true
		}

		g.Go(func() error {
			mu.Lock()
			count++
			mu.Unlock()
			return taskErr
		})
	}

	err := g.Wait()

	mu.Lock()
	got := count
	mu.Unlock()

	if got != n {
		t.Errorf("expected all %d tasks to run, only %d ran", n, got)
	}

	if err == nil {
		t.Fatal("expected Wait to return a non-nil error, got nil")
	}
	if !expectedErrs[err] {
		t.Errorf("Wait returned unexpected error: %v", err)
	}
}

// TestGroupRunsConcurrently rejects sequential execution.
// synctest makes the timing check deterministic.
func TestGroupRunsConcurrently(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var g Group

		const n = 10
		start := time.Now()

		for i := 0; i < n; i++ {
			g.Go(func() error {
				time.Sleep(100 * time.Millisecond)
				return nil
			})
		}

		err := g.Wait()
		elapsed := time.Since(start)

		if err != nil {
			t.Fatalf("expected nil error, got %v", err)
		}

		const sequentialTime = n * 100 * time.Millisecond
		const budget = 300 * time.Millisecond

		if elapsed >= budget {
			t.Errorf("Wait took %s (sequential would take %s); want well under %s - "+
				"looks like Go is running tasks one at a time instead of concurrently",
				elapsed, sequentialTime, budget)
		}
	})
}

// TestGroupFirstErrorRaceSafe makes many tasks fail at once.
// Run with `-race` to check first-error access is safe.
func TestGroupFirstErrorRaceSafe(t *testing.T) {
	var g Group

	const n = 50
	expectedErrs := make(map[error]bool, n)

	for i := 0; i < n; i++ {
		err := fmt.Errorf("task %d failed", i)
		expectedErrs[err] = true

		g.Go(func() error {
			return err
		})
	}

	got := g.Wait()

	if got == nil {
		t.Fatal("expected Wait to return a non-nil error, got nil")
	}
	if !expectedErrs[got] {
		t.Errorf("Wait returned an error that doesn't match any task's error: %v", got)
	}
}
