//////////////////////////////////////////////////////////////////////
//
// Serve is a small stand-in for the server side of an RPC framework:
// it's handed a ctx carrying the caller's deadline and a handler that
// does the real work, and it's supposed to return by that deadline no
// matter what the handler does. The catch is the handler's signature:
// func() (string, error) - it takes no ctx at all. That's deliberate.
// It represents legacy or simply synchronous business logic that has
// no way to cooperatively notice a cancellation, the same way a plain
// time.Sleep or a tight CPU loop can't. Serve can't reach into it and
// stop it early; all it can do is stop WAITING for it once the
// deadline passes, and hand the caller a timeout error instead of the
// handler's eventual result.
//
// The naive implementation below just calls handler() directly and
// returns whatever it gets - ctx is accepted as a parameter but never
// actually looked at. So a caller's timeout never has any effect:
// Serve always takes as long as the handler takes, even if that's far
// longer than the deadline the caller set.
//
// Your task is to fix Serve so that it returns by ctx's deadline (with
// ctx.Err()) if the handler hasn't finished by then, without ever
// blocking on the handler for longer than that - while still letting
// the handler's real result through if it finishes first. The
// function signature must stay the same:
//
//     func Serve(ctx context.Context, handler func() (string, error)) (string, error)
//

package main

import (
	"context"
	"fmt"
	"time"
)

// Serve runs handler and returns its result, but is supposed to give
// up and return ctx.Err() instead if ctx's deadline passes before
// handler finishes - since handler itself has no way to know about
// ctx and cannot be made to stop early.
//
// NAIVE / BROKEN: it never looks at ctx at all - it just calls
// handler() and returns whatever it gets, however long that takes.
func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
	return handler()
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	// A handler that takes 500ms and has no ctx parameter at all - it
	// cannot possibly know the caller only budgeted 100ms for it.
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

	// Give the still-running handler goroutine (once your fix spawns
	// one) time to actually finish, just so this demo doesn't exit
	// mid-flight.
	time.Sleep(500 * time.Millisecond)
}
