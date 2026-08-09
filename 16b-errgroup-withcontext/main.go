//////////////////////////////////////////////////////////////////////
//
// Group is meant to be your own tiny version of what
// golang.org/x/sync/errgroup's WithContext returns: the same
// Go/Wait pair as exercise 16, plus a derived, cancelable Context
// that lets a failing task tell every other running task to stop
// early - and that gets released no matter how the group finishes.
//
// Go/Wait already do everything exercise 16 asked for: Go launches f
// in its own goroutine, tracked via an internal sync.WaitGroup, and
// safely captures the first non-nil error via sync.Once even if
// several tasks fail around the same time. That part is correct and
// doesn't need touching.
//
// What's missing is the Context half. WithContext currently just
// hands back the ctx it was given, completely unchanged - so:
//
//   - No task ever finds out that a sibling has failed. A task that
//     checks ctx.Done() to bail out early has nothing to check
//     against, so it keeps running for its full duration regardless
//     of whether the group has already "failed".
//   - Even a fully successful Wait - every task returns nil - never
//     releases whatever a real derived Context would be holding onto.
//     context.WithCancel's own doc comment is blunt about this: its
//     CancelFunc must be called once the Context is no longer needed,
//     or its resources leak - real errgroup.WithContext calls its
//     cancel func from Wait unconditionally for exactly this reason,
//     not only on error.
//
// Your task is to fix Group and WithContext so that:
//
//   - WithContext(ctx) derives a cancelable child Context (via
//     context.WithCancel) and returns it alongside a *Group.
//   - Go(f func() error) keeps behaving exactly as it does today, but
//     additionally cancels the derived Context the instant the FIRST
//     task fails - using the same sync.Once that already guards
//     firstErr, so cancellation and error-capture happen atomically
//     together, exactly once.
//   - Wait() error keeps behaving exactly as it does today, but
//     additionally cancels the derived Context before returning, even
//     when every task succeeded - so the Context is never leaked
//     regardless of outcome.
//
// One thing to hold onto: this is COOPERATIVE cancellation. Nothing
// here can forcibly stop a running goroutine - a task that never
// selects on ctx.Done() keeps running to completion no matter what
// you do in Go/Wait. "Fail fast" only works for tasks that are
// themselves written to notice ctx and return early, same as real
// errgroup.
//
// The signatures must be:
//
//     func WithContext(ctx context.Context) (*Group, context.Context)
//     func (g *Group) Go(f func() error)
//     func (g *Group) Wait() error
//

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Group runs a collection of tasks, started via Go, and collects the
// first error (if any) returned by them once every task has finished.
type Group struct {
	wg       sync.WaitGroup
	errOnce  sync.Once
	firstErr error
}

// WithContext is supposed to return a new Group alongside a Context
// derived from ctx that gets cancelled the moment any task started via
// Go fails - and, either way, by the time Wait returns. Right now it
// just hands back ctx unchanged, so nothing ever gets cancelled.
func WithContext(ctx context.Context) (*Group, context.Context) {
	return &Group{}, ctx
}

// Go launches f in its own goroutine and returns immediately, tracking
// it via the internal sync.WaitGroup, and safely captures the first
// non-nil error via sync.Once.
func (g *Group) Go(f func() error) {
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		if err := f(); err != nil {
			g.errOnce.Do(func() {
				g.firstErr = err
			})
		}
	}()
}

// Wait blocks until every task started via Go has finished, and
// returns the first error encountered, if any.
func (g *Group) Wait() error {
	g.wg.Wait()
	return g.firstErr
}

func main() {
	g, ctx := WithContext(context.Background())

	start := time.Now()

	// A fast task that fails almost immediately.
	g.Go(func() error {
		time.Sleep(20 * time.Millisecond)
		return errors.New("task 0: config fetch failed")
	})

	// Cooperating tasks: each would take 1s unless it notices ctx was
	// cancelled and bails out early.
	for i := 1; i <= 4; i++ {
		i := i
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return fmt.Errorf("task %d: %w", i, ctx.Err())
			case <-time.After(time.Second):
				return nil
			}
		})
	}

	err := g.Wait()
	elapsed := time.Since(start)

	fmt.Printf("Wait() returned: %v\n", err)
	fmt.Printf("Elapsed: %s (siblings should notice and bail out well under 1s)\n", elapsed)
}
