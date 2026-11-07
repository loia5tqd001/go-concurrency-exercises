//////////////////////////////////////////////////////////////////////
//
// Go must start each task in its own goroutine and return.
// Wait must wait for every task and return the first error.
// Multiple task failures may race, so protect the first error.
// No context or cancellation is needed.
//
//     func (g *Group) Go(f func() error)
//     func (g *Group) Wait() error
//

package main

import (
	"errors"
	"fmt"
	"time"
)

// Group waits for tasks and keeps the first error.
type Group struct {
	firstErr error
}

// Go must run f in a new goroutine.
// The naive version runs f on the caller's goroutine.
func (g *Group) Go(f func() error) {
	if err := f(); err != nil && g.firstErr == nil {
		g.firstErr = err
	}
}

// Wait waits for all tasks and returns the first error.
func (g *Group) Wait() error {
	return g.firstErr
}

func main() {
	var g Group

	tasks := []error{
		nil,
		nil,
		errors.New("task 2 failed"),
		nil,
		errors.New("task 4 failed"),
	}

	start := time.Now()

	for i, taskErr := range tasks {
		i, taskErr := i, taskErr
		g.Go(func() error {
			time.Sleep(100 * time.Millisecond)
			if taskErr != nil {
				return fmt.Errorf("task %d: %w", i, taskErr)
			}
			return nil
		})
	}

	err := g.Wait()
	elapsed := time.Since(start)

	fmt.Printf("Wait() returned: %v\n", err)
	fmt.Printf("Elapsed: %s\n", elapsed)
}
