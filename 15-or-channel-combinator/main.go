//////////////////////////////////////////////////////////////////////
//
// Close the returned channel when any input channel closes.
// With no inputs, return a channel that never closes.
// With one input, close when it closes and do not leak a goroutine.
// With many inputs, the first closed input wins.
//
//     func or(channels ...<-chan struct{}) <-chan struct{}
//

package main

import (
	"fmt"
	"time"
)

// or closes when any input channel closes.
// The naive version watches only the first input.
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

	// This demo fires the first trigger, which the naive version watches.
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
