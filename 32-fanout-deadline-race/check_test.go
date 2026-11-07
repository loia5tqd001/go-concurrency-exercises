//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// Construct must fill every Result field before a large deadline.
func TestConstructReturnsAllFieldsWithAmpleDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		basic := NewMockComponent("basic-ok", 20*time.Millisecond)
		shipping := NewMockComponent("shipping-ok", 20*time.Millisecond)
		refund := NewMockComponent("refund-ok", 20*time.Millisecond)
		history := NewMockComponent("history-ok", 20*time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		got, err := Construct(ctx, basic.Component, shipping.Component, refund.Component, history.Component)
		if err != nil {
			t.Fatalf("Construct returned unexpected error: %v", err)
		}
		if got == nil {
			t.Fatalf("Construct returned a nil Result with no error")
		}

		want := Result{Basic: "basic-ok", Shipping: "shipping-ok", Refund: "refund-ok", History: "history-ok"}
		if *got != want {
			t.Errorf("Construct = %+v, want %+v", *got, want)
		}
	})
}

// An already-cancelled context must win over instant components.
func TestConstructAlreadyExpiredContextWins(t *testing.T) {
	for i := 0; i < 100; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		got, err := Construct(
			ctx,
			func() string { return "basic" },
			func() string { return "shipping" },
			func() string { return "refund" },
			func() string { return "history" },
		)
		if !errors.Is(err, context.Canceled) || got != nil {
			t.Fatalf("iteration %d: Construct returned (%+v, %v), want (nil, context.Canceled) for an already-cancelled context", i, got, err)
		}
	}
}

// Three components finish quickly. History takes 500ms and ignores ctx.
// Construct must return the deadline error and nil after 100ms.
// History must keep running in the background.
func TestConstructRespectsDeadlineWhenAComponentStalls(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		basic := NewMockComponent("basic-ok", 20*time.Millisecond)
		shipping := NewMockComponent("shipping-ok", 20*time.Millisecond)
		refund := NewMockComponent("refund-ok", 20*time.Millisecond)
		history := NewMockComponent("history-ok", 500*time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()

		start := time.Now()
		got, err := Construct(ctx, basic.Component, shipping.Component, refund.Component, history.Component)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("Construct returned no error; want an error from the 100ms "+
				"deadline expiring (took %s)", elapsed)
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Construct error = %v, want it to wrap context.DeadlineExceeded", err)
		}
		if got != nil {
			t.Errorf("Construct returned a non-nil Result on the deadline path "+
				"(%+v); want nil - the still-running components may still be "+
				"writing to it, so it must not be read or returned", *got)
		}

		const budget = 150 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("Construct took %s to return, want well under %s (close "+
				"to the 100ms deadline) - looks like it always waits for every "+
				"component regardless of ctx", elapsed, budget)
		}

		// Let history finish.
		// synctest requires every started goroutine to exit.
		time.Sleep(500 * time.Millisecond)

		if !history.RanToCompletion() {
			t.Errorf("history component never ran to completion in the " +
				"background - Construct giving up on waiting for it doesn't " +
				"mean the component itself stopped; it has no ctx and keeps " +
				"running regardless")
		}
	})
}

// Concurrent calls must not race on Result.
func TestConstructConcurrentSafety(t *testing.T) {
	const calls = 20

	var wg sync.WaitGroup
	wg.Add(calls)

	for i := 0; i < calls; i++ {
		go func() {
			defer wg.Done()

			basic := NewMockComponent("a", 1*time.Millisecond)
			shipping := NewMockComponent("b", 2*time.Millisecond)
			refund := NewMockComponent("c", 3*time.Millisecond)
			history := NewMockComponent("d", 8*time.Millisecond)

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
			defer cancel()

			_, _ = Construct(ctx, basic.Component, shipping.Component, refund.Component, history.Component)
		}()
	}

	wg.Wait()
}
