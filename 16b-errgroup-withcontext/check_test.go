//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// TestGroupRunsAllTasksAndCapturesFirstError is the same correctness
// baseline as exercise 16: every task registered via Go must run to
// completion, and Wait must report a non-nil error when at least one
// task failed. Confirms the WithContext-returned Group still gets the
// basics right before layering the cancellation checks on top.
func TestGroupRunsAllTasksAndCapturesFirstError(t *testing.T) {
	g, _ := WithContext(context.Background())

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

// TestFailFastCancelsSiblingContext is the key test: the moment one
// task fails, the Context handed to every other task must be
// cancelled, so a cooperating sibling notices via ctx.Done() and
// returns early instead of running its full duration. synctest.Test
// runs the body on a fake clock that jumps forward only once every
// goroutine in the bubble is durably blocked, so this assertion is
// exact and doesn't flake on a busy machine.
func TestFailFastCancelsSiblingContext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g, ctx := WithContext(context.Background())

		start := time.Now()

		g.Go(func() error {
			return errors.New("boom")
		})

		const n = 5
		for i := 0; i < n; i++ {
			g.Go(func() error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Second):
					return nil
				}
			})
		}

		err := g.Wait()
		elapsed := time.Since(start)

		if err == nil {
			t.Fatal("expected Wait to return the failing task's error, got nil")
		}

		const budget = 100 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("Wait took %s; want well under %s - looks like the "+
				"derived Context is never cancelled when a task fails, so "+
				"cooperating siblings ran their full 1s timeout instead of "+
				"noticing ctx.Done() and bailing out early", elapsed, budget)
		}
	})
}

// TestWaitCancelsContextEvenOnSuccess checks the other half: even when
// every task succeeds, Wait must still cancel the derived Context
// before returning - otherwise its resources leak for as long as the
// parent Context stays alive, exactly the mistake go vet's lostcancel
// check flags in ordinary code.
func TestWaitCancelsContextEvenOnSuccess(t *testing.T) {
	g, ctx := WithContext(context.Background())

	g.Go(func() error { return nil })
	g.Go(func() error { return nil })

	if err := g.Wait(); err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	if ctx.Err() == nil {
		t.Error("expected ctx to be cancelled once Wait returns, even " +
			"though no task failed - otherwise the derived Context leaks")
	}
}

// TestWithContextDerivesFromParent guards against a fix that creates a
// brand new cancelable Context from context.Background() instead of
// deriving one from the ctx it was actually given - every other test
// in this file passes context.Background() as the parent, so a
// WithContext that silently ignores its argument and calls
// context.WithCancel(context.Background()) would slip past all of
// them undetected. Here the parent carries a value and gets cancelled
// independently, so only a Context genuinely derived from it behaves
// correctly on both counts.
func TestWithContextDerivesFromParent(t *testing.T) {
	type ctxKey string
	const key ctxKey = "trace-id"

	parent, parentCancel := context.WithCancel(context.WithValue(context.Background(), key, "abc123"))
	defer parentCancel()

	_, ctx := WithContext(parent)

	if v, _ := ctx.Value(key).(string); v != "abc123" {
		t.Fatalf("derived Context lost the parent's value: got %q, want %q - "+
			"looks like WithContext isn't deriving from the ctx it was given",
			v, "abc123")
	}

	parentCancel()

	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("derived Context was not cancelled when its parent was cancelled - " +
			"looks like WithContext isn't deriving from the ctx it was given")
	}
}

// TestFirstErrorAndCancelRaceSafe stress-tests the "first error wins"
// bookkeeping (and its accompanying cancel call) with many tasks that
// all fail immediately, racing to finish and to trigger cancellation
// at roughly the same time. Run with `go test -race` to catch any
// unsynchronized access.
func TestFirstErrorAndCancelRaceSafe(t *testing.T) {
	g, ctx := WithContext(context.Background())

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
	if ctx.Err() == nil {
		t.Error("expected ctx to be cancelled after Wait returns")
	}
}
