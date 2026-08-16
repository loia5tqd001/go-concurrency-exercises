//////////////////////////////////////////////////////////////////////
//
// or combines any number of independent shutdown-trigger channels - a
// failed health check, an admin-requested shutdown, a deadline
// expiring, ... - into a single channel a caller can select on. It
// must close as soon as ANY ONE of the input channels closes, no
// matter which one:
//
//   today (broken):                      goal:
//   channels[0] ──▶ watched               channels[0] ─┐
//   channels[1] ···  ignored               channels[1] ─┼─▶ combined closes
//   channels[2] ···  ignored               channels[2] ─┘   the instant ANY
//   (closing 1 or 2 does nothing)                           one of them closes
//
// Right now or only ever watches channels[0]. Closing any channel
// OTHER than channels[0] has no effect on the returned channel at all
// - it just sits there, blocked forever, even though one of the
// shutdown triggers already fired.
//
// Your task is to fix or so the returned channel closes as soon as
// ANY of the input channels closes:
//
//   - With zero input channels there is nothing to wait on, so the
//     simplest correct behavior is to return a channel that is never
//     closed.
//   - With exactly one input channel, closing it must close the
//     combined channel promptly - without leaving behind a goroutine
//     that outlives the call when that one channel never closes
//     (completely normal for one of several independent triggers that
//     doesn't end up firing).
//   - With more than one input channel, the combined channel must
//     close the instant any of them closes, no matter which one, and
//     no matter how many there are.
//
// The function signature must stay the same:
//
//     func or(channels ...<-chan struct{}) <-chan struct{}
//
// so that it remains a drop-in replacement for the naive version
// below.
//

package main

import (
	"fmt"
	"time"
)

// or is supposed to combine any number of done/signal channels into a
// single channel that closes as soon as ANY of the input channels
// closes - useful for combining independent shutdown triggers (e.g.
// health-check-failed, admin-requested-shutdown, deadline-exceeded)
// into one signal callers can select on. Right now it ignores every
// channel except the first one it was given, so closing any channel
// OTHER than channels[0] has no effect on the returned channel at
// all.
func or(channels ...<-chan struct{}) <-chan struct{} {
	orDone := make(chan struct{})
	if len(channels) == 0 {
		return orDone
	}

	go func() {
		defer close(orDone)
		<-channels[0]
	}()

	return orDone
}

func main() {
	healthCheckFailed := make(chan struct{})
	adminShutdown := make(chan struct{})
	deadlineExceeded := make(chan struct{})

	// Only the first trigger fires in this demo, so the program
	// completes even against the naive implementation above (which
	// only ever watches channels[0]). The naive implementation's bug
	// - ignoring every channel other than the first - only shows up
	// when a channel OTHER than channels[0] is the one that closes,
	// which is exactly what check_test.go exercises.
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(healthCheckFailed)
	}()

	start := time.Now()
	combined := or(healthCheckFailed, adminShutdown, deadlineExceeded)
	<-combined
	elapsed := time.Since(start)

	fmt.Printf("shutdown signal received after %s (triggered by healthCheckFailed)\n", elapsed)
}
