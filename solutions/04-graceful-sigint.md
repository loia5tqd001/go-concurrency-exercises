# Graceful SIGINT Killing — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `04-graceful-sigint/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`MockProcess.Run()` blocks forever, printing a dot every second. The only
built-in escape hatch is the operating system: press Ctrl-C and the process
dies immediately. The exercise asks for two behaviors layered on top of that:

1. On the **first** SIGINT, call `proc.Stop()` and give it a chance to shut
   things down gracefully.
2. On a **second** SIGINT (the user is impatient, or the graceful stop is
   taking forever / never finishes), kill the program immediately — no more
   waiting.

The mock's `Stop()` is deliberately adversarial: it never returns
("in this mock example this will not succeed"), so any solution that waits
unconditionally for `Stop()` to finish will hang forever unless it also
listens for a second signal (or a timeout).

```go
func main() {
	proc := MockProcess{}
	proc.Run() // blocks forever
}
```

There is no `signal.Notify` call at all, so the *default* OS disposition for
SIGINT applies: the very first Ctrl-C terminates the process outright.
`proc.Stop()` is never invoked — there is no graceful shutdown, no matter how
many times you press Ctrl-C. `check_test.go` spawns this exact scaffold as a
subprocess and sends it real `os.Interrupt` signals; against the naive
version above it fails fast instead of hanging:

```
$ go test -v ./04-graceful-sigint/...
=== RUN   TestFirstSigintTriesGracefulStopWithoutExiting
    check_test.go:134: timed out after 5s waiting for output containing "Stopping process"; got:
        Process running...
--- FAIL: TestFirstSigintTriesGracefulStopWithoutExiting (5.12s)
=== RUN   TestSecondSigintForcesPromptExit
    check_test.go:161: timed out after 5s waiting for output containing "Stopping process"; got:
        Process running...
--- FAIL: TestSecondSigintForcesPromptExit (5.13s)
FAIL
FAIL	github.com/loia5tqd001/go-concurrency-exercises/04-graceful-sigint	12.046s
FAIL
```

## Approach 1: buffered signal channel + `select` (recommended)

The idiomatic Go pattern: register interest in `os.Interrupt` on a buffered
channel, run the process in its own goroutine (so it doesn't block `main`),
and run `Stop()` in *its own* goroutine too — that's the key trick that lets
`main` keep listening for a second signal instead of being stuck inside a
blocking `Stop()` call.

```go
package main

import (
	"fmt"
	"os"
	"os/signal"
)

func main() {
	// Create a process
	proc := MockProcess{}

	// Run the process (blocking) in the background
	go proc.Run()

	// Register interest in SIGINT signals; the channel must be buffered
	// (size >= 1) so signal delivery never blocks, and here we allow
	// room for both the first and a subsequent signal to be queued.
	sigChan := make(chan os.Signal, 2)
	signal.Notify(sigChan, os.Interrupt)

	// Block until the first signal is received
	<-sigChan
	fmt.Println("\nFirst signal received, stopping process gracefully...")

	// Try to stop the process gracefully in its own goroutine, so the
	// main goroutine stays free to keep listening for a second signal
	// instead of blocking inside proc.Stop().
	stopped := make(chan struct{})
	go func() {
		proc.Stop()
		close(stopped)
	}()

	// Wait for whichever happens first: the graceful stop finishing,
	// or a second signal telling us to kill it right away.
	select {
	case <-stopped:
		fmt.Println("Process gracefully stopped")
	case <-sigChan:
		fmt.Println("Second signal received, killing process")
		os.Exit(1)
	}
}
```

### Why this works

- `go proc.Run()` frees `main` from the very start, so it can immediately
  set up signal handling instead of being stuck inside an infinite loop.
- `signal.Notify` with a buffered channel guarantees the runtime never drops
  or blocks on signal delivery — a channel of capacity 2 comfortably holds
  both the first and second SIGINT even if they arrive in quick succession
  before `main` has read the first one.
- The crucial move is `go func() { proc.Stop(); close(stopped) }()`. If we
  called `proc.Stop()` directly (not in a goroutine), `main` would be stuck
  inside that call — and since the mock's `Stop()` never returns, `main`
  would never reach a second `<-sigChan`, so a second Ctrl-C would just sit
  in the buffered channel unread. Running `Stop()` on its own goroutine lets
  `main`'s `select` race "did the stop finish?" against "did another signal
  arrive?".
- `os.Exit(1)` on the second signal terminates immediately, without waiting
  for the (never-finishing) graceful stop goroutine — exactly the "last
  resort" behavior the exercise asks for.

### Verified

`check_test.go` spawns the program as a real subprocess and drives it with
actual `os.Interrupt` signals. Against this fix, both tests pass — the first
SIGINT reaches `proc.Stop()` without exiting, and the second SIGINT forces a
prompt exit even though `Stop()` never returns:

```
$ go test -v -race ./04-graceful-sigint/...
=== RUN   TestFirstSigintTriesGracefulStopWithoutExiting
--- PASS: TestFirstSigintTriesGracefulStopWithoutExiting (0.63s)
=== RUN   TestSecondSigintForcesPromptExit
--- PASS: TestSecondSigintForcesPromptExit (0.14s)
PASS
ok  	github.com/loia5tqd001/go-concurrency-exercises/04-graceful-sigint	3.224s
```

Also clean across `go test -race -count=20`, with no flakes.

## Approach 2: bound the wait with a `context.Context` timeout (alternative)

Approach 1 waits *indefinitely* for either a second signal or a successful
stop. A meaningfully different variant adds a **timeout** as a third exit
path — useful if you want the program to self-terminate after a grace
period even if the user never sends a second Ctrl-C:

```go
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"time"
)

func main() {
	proc := MockProcess{}
	go proc.Run()

	sigChan := make(chan os.Signal, 2)
	signal.Notify(sigChan, os.Interrupt)

	<-sigChan
	fmt.Println("\nShutting down gracefully (Ctrl-C again to force)...")

	// Bound how long we're willing to wait for a graceful stop.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stopped := make(chan struct{})
	go func() {
		proc.Stop()
		close(stopped)
	}()

	select {
	case <-stopped:
		fmt.Println("Stopped gracefully")
	case <-sigChan:
		fmt.Println("Second interrupt - killing now")
		os.Exit(1)
	case <-ctx.Done():
		fmt.Println("Graceful shutdown timed out - killing now")
		os.Exit(1)
	}
}
```

This keeps the same "second signal forces exit" behavior as Approach 1, but
adds `ctx.Done()` as a third `select` case, so the program also gives up on
its own after a fixed grace period — handy in non-interactive contexts
(systemd, containers) where nothing may ever send a second signal.

This variant also passes `check_test.go` unchanged: the first SIGINT still
reaches `proc.Stop()` without exiting, and the second SIGINT still forces a
prompt exit, well before the 10-second timeout would ever fire.

## Key takeaways

- Anything that should keep running or keep listening after the first
  signal must not be blocked *inside* a call that might never return — run
  it on its own goroutine and rendezvous via a `select`.
- `signal.Notify` **requires** a buffered channel; an unbuffered one risks
  the runtime dropping signals it can't deliver without blocking.
- A `select` over "work finished" vs. "signal received" (optionally plus
  "timeout elapsed") is the general shape for *any* "graceful-shutdown with
  a forced fallback" problem in Go, not just SIGINT handling.
- `os.Exit()` skips deferred functions and any cleanup — use it deliberately
  as the "last resort" path, not as the normal exit route.
