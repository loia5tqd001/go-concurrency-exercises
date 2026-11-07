//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

// TestHandleRequestSucceedsWithAmpleTimeout gives all layers enough time.
// The call should return "ABC" with no error.
// The current code and a fixed version both pass.
func TestHandleRequestSucceedsWithAmpleTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		got, err := HandleRequest(ctx)
		if err != nil {
			t.Fatalf("HandleRequest returned unexpected error: %v", err)
		}

		if want := "ABC"; got != want {
			t.Errorf("HandleRequest = %q, want %q", got, want)
		}
	})
}

// TestHandleRequestRespectsTimeout gives HandleRequest 200ms.
// One layer takes 300ms, so the request must fail early.
// A correct solution returns a deadline error in about 200ms.
// The current code ignores ctx and runs all three layers.
func TestHandleRequestRespectsTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()

		start := time.Now()
		_, err := HandleRequest(ctx)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("HandleRequest returned no error; want an error from the "+
				"200ms timeout expiring (took %s)", elapsed)
		}

		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("HandleRequest error = %v, want it to wrap context.DeadlineExceeded", err)
		}

		const budget = 350 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("HandleRequest took %s to fail, want well under %s "+
				"(close to the 200ms timeout) - looks like ctx isn't being "+
				"propagated into the layer calls, so they run to completion "+
				"regardless of the caller's deadline", elapsed, budget)
		}
	})
}

// TestHandleRequestCancelledMidway cancels the context during layer B.
// A correct solution stops quickly and does not continue.
func TestHandleRequestCancelledMidway(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		type result struct {
			val string
			err error
		}
		resCh := make(chan result, 1)

		start := time.Now()
		go func() {
			val, err := HandleRequest(ctx)
			resCh <- result{val, err}
		}()

		time.Sleep(350 * time.Millisecond)
		cancel()

		// This receive blocks on a bubble channel.
		// Fake time advances until HandleRequest sends its result.
		res := <-resCh
		elapsed := time.Since(start)

		if !errors.Is(res.err, context.Canceled) {
			t.Errorf("HandleRequest error = %v, want context.Canceled", res.err)
		}

		const budget = 500 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("HandleRequest took %s to return after cancellation, want well "+
				"under %s - looks like it kept running later layers instead of "+
				"giving up promptly once ctx was cancelled", elapsed, budget)
		}
	})
}
