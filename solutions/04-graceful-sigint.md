# Graceful SIGINT Killing — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `04-graceful-sigint/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`MockProcess.Run()` blocks forever and prints a dot every second. Ctrl-C
normally stops the process at once. The exercise adds two behaviors:

1. On the first SIGINT, call `proc.Stop()` and try a graceful shutdown.
2. On a second SIGINT, stop the program at once.

The mock's `Stop()` never returns. The comment says it will not succeed.
A solution that waits only for `Stop()` will hang. It must also listen
for a second signal or a timeout.

```go
func main() {
	proc := MockProcess{}
	proc.Run() // blocks forever
}
```

There is no `signal.Notify` call. The default SIGINT behavior applies. The
first Ctrl-C stops the process. `proc.Stop()` never runs.

`check_test.go` starts this scaffold as a subprocess. It sends real
`os.Interrupt` signals. The starting version fails:

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

The common Go pattern has three parts. Listen for `os.Interrupt` on a
buffered channel. Run the process in its own goroutine. Run `Stop()` in
another goroutine. Then `main` can still listen for a second signal.

```go {30,31,32}
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

- `go proc.Run()` lets `main` set up signal handling at once.
- The buffered channel holds both signals. A capacity of 2 is enough. The
  runtime does not drop or block signal delivery.
- `go func() { proc.Stop(); close(stopped) }()` keeps `main` free. A direct
  `proc.Stop()` call would never return. `main` could not read a second
  `<-sigChan`. The goroutine lets `select` wait for two outcomes: stop
  finished, or another signal arrived.
- `os.Exit(1)` on the second signal stops at once. It does not wait for
  the graceful stop.

### Verified

`check_test.go` runs the program and sends real `os.Interrupt` signals.
Both tests pass. The first SIGINT reaches `proc.Stop()`. The second SIGINT
forces a fast exit even though `Stop()` never returns:

```
$ go test -v -race ./04-graceful-sigint/...
=== RUN   TestFirstSigintTriesGracefulStopWithoutExiting
--- PASS: TestFirstSigintTriesGracefulStopWithoutExiting (0.63s)
=== RUN   TestSecondSigintForcesPromptExit
--- PASS: TestSecondSigintForcesPromptExit (0.14s)
PASS
ok  	github.com/loia5tqd001/go-concurrency-exercises/04-graceful-sigint	3.224s
```

It also passes `go test -race -count=20` with no flakes.

## Approach 2: bound the wait with a `context.Context` timeout (alternative)

Approach 1 waits for a second signal or a clean stop. This variant adds a
timeout as a third exit path. The program can stop after a grace period
even if nobody sends another Ctrl-C:

```go {22,37}
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

This keeps the second-signal exit. It adds `ctx.Done()` as a third
`select` case. The program also gives up after 10 seconds. This helps in
systemd or containers, where nobody may send a second signal.

This variant passes `check_test.go` unchanged. The first SIGINT reaches
`proc.Stop()`. The second SIGINT forces a fast exit before the timeout.

## Key takeaways

- A call may never return. Do not block `main` inside it if `main` must
  keep listening. Use a goroutine and a `select`.
- `signal.Notify` needs a buffered channel. An unbuffered channel can drop
  signals if the runtime cannot deliver without blocking.
- Use `select` to wait for work, a signal, and maybe a timeout. This
  pattern fits any graceful shutdown with a forced fallback.
- `os.Exit()` skips deferred calls and cleanup. Use it only as a last
  resort.
