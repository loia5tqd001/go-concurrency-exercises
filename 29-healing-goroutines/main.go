//////////////////////////////////////////////////////////////////////
//
// A ward is a long-running goroutine with a heartbeat.
// It can stop pulsing without exiting or accepting cancellation.
//
// A steward watches a ward and restarts it after a stall.
// The new ward needs a fresh done channel controlled by the steward.
// The steward forwards the current ward's pulses.
//
// NewSteward starts only one ward and forwards its heartbeat.
// It does not monitor or restart that ward.
//
// Your task is to make NewSteward:
//   - start each ward with a fresh steward-owned done.
//   - forward heartbeats from the current ward.
//   - restart after timeout passes without a pulse.
//   - stop the current ward and itself when its own done closes.
//
// A stalled ward may ignore done, so never wait for it to exit.

package main

import (
	"fmt"
	"time"
)

// StartGoroutineFn starts one goroutine and returns its heartbeat.
type StartGoroutineFn func(done <-chan struct{}, pulseInterval time.Duration) (heartbeat <-chan struct{})

// NewSteward returns a monitored ward.
// A stall should start a new ward generation.
func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn {
	return func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
		// BUG: this forwards done and heartbeat with no monitoring.
		return ward(done, pulseInterval)
	}
}

func main() {
	const (
		pulseInterval     = 50 * time.Millisecond
		timeout           = 200 * time.Millisecond
		pulsesBeforeWedge = 4
	)

	ward := NewMockWard(pulsesBeforeWedge)
	steward := NewSteward(timeout, ward.Start)

	done := make(chan struct{})
	heartbeat := steward(done, pulseInterval)

	for i := 1; i <= 10; i++ {
		select {
		case <-heartbeat:
			fmt.Println("pulse", i)
		case <-time.After(pulseInterval * 4):
			fmt.Println("no pulse this round")
		}
	}

	close(done)
	fmt.Println("ward generations started:", ward.Generations())
}
