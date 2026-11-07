//////////////////////////////////////////////////////////////////////
//
// Serve runs a handler that does not accept a context.
// The handler cannot be stopped after it starts.
// Serve must stop waiting when the caller's context ends.
// A real result must still pass through if it finishes first.
//
// The current version ignores the context and always waits.
// Keep the signature:
//
//     func Serve(ctx context.Context, handler func() (string, error)) (string, error)
//

package main

import (
	"context"
	"fmt"
	"time"
)

// Serve returns the handler's result or ctx.Err(), whichever wins.
// The handler keeps running if ctx ends first.
//
// BROKEN: It ignores ctx and always waits for the handler.
func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
	return handler()
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	// This handler takes 500ms and cannot see the 100ms deadline.
	slowHandler := func() (string, error) {
		time.Sleep(500 * time.Millisecond)
		return "finally done", nil
	}

	start := time.Now()
	result, err := Serve(ctx, slowHandler)
	elapsed := time.Since(start)

	if err != nil {
		fmt.Printf("Serve failed after %s: %v\n", elapsed, err)
	} else {
		fmt.Printf("Serve succeeded after %s: %q\n", elapsed, result)
	}
	fmt.Println("...but the 100ms deadline was supposed to mean Serve gives up long before 500ms.")

	// Let the handler finish before the demo exits.
	time.Sleep(500 * time.Millisecond)
}
