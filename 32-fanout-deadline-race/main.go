//////////////////////////////////////////////////////////////////////
//
// Construct starts four independent components at once.
// Each component writes a different Result field.
// The current version waits for all of them and ignores ctx.
//
// Fix it so it returns ctx.Err() and nil when ctx ends first.
// Do not read or return Result while components may still write it.
// Concurrent writes to different fields are safe.
// Reading Result before every writer finishes is a data race.
//
// Keep the signature:
//
//     func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error)
//

package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Component is one independent piece of work.
// It cannot be stopped after it starts.
type Component func() string

// Result holds the output of all four components.
// Each field has one writer.
// Do not read the struct until all writes finish.
type Result struct {
	Basic    string
	Shipping string
	Refund   string
	History  string
}

// Construct runs all four components and returns their Result.
// It must return ctx.Err() and nil if ctx ends first.
//
// BROKEN: wg.Wait() ignores ctx and waits for the slowest component.
func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
	var result Result
	var wg sync.WaitGroup

	wg.Add(4)
	go func() {
		defer wg.Done()
		result.Basic = basic()
	}()
	go func() {
		defer wg.Done()
		result.Shipping = shipping()
	}()
	go func() {
		defer wg.Done()
		result.Refund = refund()
	}()
	go func() {
		defer wg.Done()
		result.History = history()
	}()

	wg.Wait()
	return &result, nil
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	fast := func(name string) Component {
		return func() string {
			time.Sleep(20 * time.Millisecond)
			return name + "-ok"
		}
	}

	// History takes 500ms and cannot observe the context.
	stalled := func() string {
		time.Sleep(500 * time.Millisecond)
		return "history-ok"
	}

	start := time.Now()
	result, err := Construct(ctx, fast("basic"), fast("shipping"), fast("refund"), stalled)
	elapsed := time.Since(start)

	if err != nil {
		fmt.Printf("Construct failed after %s: %v\n", elapsed, err)
	} else {
		fmt.Printf("Construct succeeded after %s: %+v\n", elapsed, result)
	}
	fmt.Println("...but the 100ms deadline was supposed to mean Construct gives up long before 500ms.")

	// Let history finish before the demo exits.
	time.Sleep(500 * time.Millisecond)
}
