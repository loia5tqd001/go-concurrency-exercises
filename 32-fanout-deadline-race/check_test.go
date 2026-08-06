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

// TestConstructReturnsAllFieldsWithAmpleDeadline checks the happy
// path: with a deadline comfortably larger than every component's
// latency, Construct should return a fully populated Result with no
// error. This holds for both the naive implementation and a properly
// fixed one - the bug only shows up once a component outlasts the
// deadline.
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

// TestConstructRespectsDeadlineWhenAComponentStalls is the key test.
// Three components are fast; history takes 500ms and, like every
// component here, has no ctx parameter at all, so it cannot notice
// the deadline elapsing. Construct is given only a 100ms deadline. A
// correct implementation stops waiting once the deadline passes and
// returns ctx.Err() with a nil Result promptly; it does NOT (and
// cannot) make the stalled component itself stop running.
//
// The naive implementation calls wg.Wait() unconditionally, so it
// takes history's full 500ms regardless of the 100ms deadline, and
// returns a fully populated Result with no error at all - exactly the
// bug this exercise is about.
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

		// Give the still-running history component goroutine time to
		// actually finish its full 500ms before this synctest bubble
		// closes: synctest requires every goroutine started inside
		// the bubble to have exited by the time this function
		// returns, or it panics with a deadlock report.
		time.Sleep(500 * time.Millisecond)

		if !history.RanToCompletion() {
			t.Errorf("history component never ran to completion in the " +
				"background - Construct giving up on waiting for it doesn't " +
				"mean the component itself stopped; it has no ctx and keeps " +
				"running regardless")
		}
	})
}

// TestConstructConcurrentSafety hammers Construct with many concurrent
// calls, each racing four mock components against a tight deadline, to
// catch data races on the shared Result (run with `go test -race`).
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
