//////////////////////////////////////////////////////////////////////
//
// Construct is supposed to build a Result by fanning out to four
// independent components - basic, shipping, refund, and history (see
// mockcomponent.go) - concurrently, each writing into its own field of
// a shared Result struct, then waiting for all four before returning
// it. Each component has no ctx parameter: like Serve in the previous
// exercise, a component has no way to cooperatively notice ctx being
// done, and once started it always runs for its full latency.
//
// The current implementation fans out correctly but then calls
// wg.Wait() unconditionally, with no regard for ctx at all. If even
// one component is slower than the caller's deadline, Construct
// blocks for however long that component takes - the caller's
// deadline is completely ignored.
//
// Your task is to fix Construct so that it returns promptly with
// ctx.Err() (and a nil *Result) if ctx's deadline passes before every
// component has finished, instead of always waiting for the slowest
// one regardless. Two things to hold onto:
//
//   - The four goroutines write to *disjoint* fields of the same
//     Result struct, so there's no data race between them - as long as
//     nothing reads the struct before wg.Wait() has actually returned.
//   - If you bail out via ctx.Done(), the component goroutines are
//     still running and still writing to result's fields in the
//     background. Do NOT read result (or return a pointer to it) on
//     that path - there's no synchronization between those writes and
//     whatever would be reading it, which is exactly the kind of
//     unsynchronized read the "disjoint fields don't race" fact above
//     does not protect you from. Return nil instead.
//
// The function signature must stay the same:
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

// Component is one independent piece of work Construct fans out to.
// Like the handler in the previous exercise, it takes no ctx - it has
// no way to be told to stop early once started.
type Component func() string

// Result holds the output of all four components. Each field is
// written by exactly one goroutine in Construct, so concurrent writes
// to different fields never race with each other - only reading the
// struct before every writer has finished would be a problem.
type Result struct {
	Basic    string
	Shipping string
	Refund   string
	History  string
}

// Construct fans out to all four components concurrently and waits
// for every one of them before returning the assembled Result. It's
// supposed to give up and return ctx.Err() instead if ctx's deadline
// passes first, without reading the (possibly still being written to)
// Result.
//
// NAIVE / BROKEN: wg.Wait() blocks unconditionally, so ctx has no
// effect at all - Construct always waits for the slowest component,
// however long that takes.
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

	// history is the one slow, ctx-blind component - it takes 500ms
	// no matter what, the same way a synchronous downstream call with
	// no ctx parameter might in a real service.
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

	// Give the still-running history component time to actually
	// finish, just so this demo doesn't exit mid-flight.
	time.Sleep(500 * time.Millisecond)
}
