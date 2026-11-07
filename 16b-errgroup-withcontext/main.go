//////////////////////////////////////////////////////////////////////
//
// WithContext must derive a cancelable child context.
// The first task error must cancel that context.
// Wait must always cancel the context, even after success.
// Cancellation is cooperative. Tasks must check ctx.Done().
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

// Group waits for tasks and keeps the first error.
type Group struct {
	wg       sync.WaitGroup
	errOnce  sync.Once
	firstErr error
}

// WithContext returns a Group and a cancelable child context.
// The naive version returns the parent context unchanged.
func WithContext(ctx context.Context) (*Group, context.Context) {
	return &Group{}, ctx
}

// Go runs f in a new goroutine and records the first error.
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

// Wait waits for all tasks and returns the first error.
func (g *Group) Wait() error {
	g.wg.Wait()
	return g.firstErr
}

func main() {
	g, ctx := WithContext(context.Background())

	start := time.Now()

	// This task fails quickly.
	g.Go(func() error {
		time.Sleep(20 * time.Millisecond)
		return errors.New("task 0: config fetch failed")
	})

	// These tasks stop early when the context is cancelled.
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
