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

// Serve must return the handler result before a large deadline.
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

// Serve must stop waiting after 100ms even if the handler runs for 500ms.
// The handler cannot see ctx and keeps running in the background.
// Serve must return the deadline error, not a successful result.
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

		// Let the background handler finish.
		// synctest requires every started goroutine to exit.
		time.Sleep(500 * time.Millisecond)

		if !h.RanToCompletion() {
			t.Errorf("handler never ran to completion in the background - " +
				"Serve giving up on waiting for it doesn't mean the handler " +
				"itself stopped; it has no ctx and keeps running regardless")
		}
	})
}

// Serve must return both the handler value and its error.
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

// An already-cancelled context must win over an instant handler.
func TestServeAlreadyExpiredContextWinsEvenWhenHandlerIsInstant(t *testing.T) {
	for i := 0; i < 100; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		got, err := Serve(ctx, func() (string, error) {
			return "too late", nil
		})
		if !errors.Is(err, context.Canceled) || got != "" {
			t.Fatalf("iteration %d: Serve returned (%q, %v), want (\"\", context.Canceled) for an already-cancelled context", i, got, err)
		}
	}
}

// Concurrent calls must be race-free.
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
