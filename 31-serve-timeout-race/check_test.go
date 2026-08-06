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

// TestServeReturnsHandlerResultWithAmpleDeadline checks the happy
// path: with a deadline comfortably larger than the handler's own
// latency, Serve should return the handler's result with no error.
// This holds for both the naive implementation and a properly fixed
// one - the bug only shows up once the deadline is the tighter side
// of the race.
func TestServeReturnsHandlerResultWithAmpleDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := NewMockHandler("payload", 50*time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		got, err := Serve(ctx, h.Handler)
		if err != nil {
			t.Fatalf("Serve returned unexpected error: %v", err)
		}
		if want := "payload"; got != want {
			t.Errorf("Serve = %q, want %q", got, want)
		}
	})
}

// TestServeRespectsDeadlineWhenHandlerIgnoresCtx is the key test. The
// handler takes 500ms and has no way to notice ctx at all - it's not
// even given a ctx parameter. Serve is given only a 100ms deadline. A
// correct implementation stops waiting on the handler once the
// deadline passes and returns ctx.Err() promptly; it does NOT (and
// cannot) make the handler itself stop running.
//
// The naive implementation just calls handler() and returns whatever
// it gets, so it takes the handler's full 500ms regardless of the
// 100ms deadline, and returns a successful result with no error at
// all - exactly the bug this exercise is about.
func TestServeRespectsDeadlineWhenHandlerIgnoresCtx(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := NewMockHandler("too-late", 500*time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()

		start := time.Now()
		_, err := Serve(ctx, h.Handler)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("Serve returned no error; want an error from the 100ms "+
				"deadline expiring (took %s)", elapsed)
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Serve error = %v, want it to wrap context.DeadlineExceeded", err)
		}

		const budget = 150 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("Serve took %s to return, want well under %s (close to "+
				"the 100ms deadline) - looks like it's blocking on the handler "+
				"regardless of ctx, instead of racing the deadline against it",
				elapsed, budget)
		}

		// Give the still-running handler goroutine (in a correct
		// implementation, one is spawned to race against ctx.Done())
		// time to actually finish its full 500ms before this synctest
		// bubble closes: synctest requires every goroutine started
		// inside the bubble to have exited by the time this function
		// returns, or it panics with a deadlock report.
		time.Sleep(500 * time.Millisecond)

		if !h.RanToCompletion() {
			t.Errorf("handler never ran to completion in the background - " +
				"Serve giving up on waiting for it doesn't mean the handler " +
				"itself stopped; it has no ctx and keeps running regardless")
		}
	})
}

// TestServeReturnsHandlerErrorWhenItWinsTheRace checks that Serve
// propagates the handler's own error alongside its value when the
// handler finishes before the deadline, rather than discarding it.
func TestServeReturnsHandlerErrorWhenItWinsTheRace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		wantErr := errors.New("boom")
		h := NewMockHandler("value", 10*time.Millisecond).WithError(wantErr)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		got, err := Serve(ctx, h.Handler)

		if got != "value" {
			t.Errorf("Serve = %q, want %q (the handler's value, alongside its error)", got, "value")
		}
		if !errors.Is(err, wantErr) {
			t.Errorf("Serve err = %v, want the handler's own error %v - it must "+
				"be returned, not discarded", err, wantErr)
		}
	})
}

// TestServeConcurrentSafety hammers Serve with many concurrent calls,
// each racing a mock handler against its own deadline, to catch data
// races (run with `go test -race`).
func TestServeConcurrentSafety(t *testing.T) {
	const calls = 20

	var wg sync.WaitGroup
	wg.Add(calls)

	for i := 0; i < calls; i++ {
		go func() {
			defer wg.Done()

			h := NewMockHandler("x", 2*time.Millisecond)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()

			_, _ = Serve(ctx, h.Handler)
		}()
	}

	wg.Wait()
}
