//////////////////////////////////////////////////////////////////////
//
// DoWork runs work units and sends one result per unit.
// It should also send heartbeats while it works.
// A heartbeat distinguishes a slow unit from a stalled one.
//
// The current code sends one heartbeat at startup.
// It sends nothing while a unit is running.
// WorkWithTimeout uses one timer for the whole job.
// That timer cannot find a stall quickly.
//
// Your task is to fix both:
//   - DoWork sends heartbeats during each unit.
//     It must still stop when done closes.
//   - WorkWithTimeout listens for heartbeats and results.
//     It resets a timer after each one.
//     It returns an error after one quiet timeout.
//
// Keep these signatures:
//
//	func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int)
//	func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error)
//
// stallAfter outside the work range disables the simulated stall.
//

package main

import (
	"fmt"
	"time"
)

// workerPulseInterval is shorter than a normal perPulseTimeout.
const workerPulseInterval = 100 * time.Millisecond

// DoWork runs the units and returns heartbeat and result channels.
func DoWork(done <-chan struct{}, pulseInterval time.Duration, workUnits int) (heartbeat <-chan struct{}, results <-chan int) {
	// Keep this buffer for the startup pulse.
	// The naive WorkWithTimeout ignores heartbeat.
	hb := make(chan struct{}, 1)
	res := make(chan int)

	go func() {
		defer close(res)

		// This one pulse does not show later progress.
		select {
		case hb <- struct{}{}:
		case <-done:
			return
		}

		// checkIn should send a heartbeat.
		// The current callback does nothing.
		checkIn := func() bool { return true }

		for i := 0; i < workUnits; i++ {
			if !SimulateUnit(done, i, pulseInterval, checkIn) {
				return
			}

			select {
			case res <- i:
			case <-done:
				return
			}
		}
	}()

	return hb, res
}

// WorkWithTimeout collects results until it ends or the worker stalls.
func WorkWithTimeout(workUnits int, stallAfter int, perPulseTimeout time.Duration) ([]int, error) {
	SetStallUnit(stallAfter)

	done := make(chan struct{})
	defer close(done)

	_, results := DoWork(done, workerPulseInterval, workUnits)

	// This one deadline covers the whole job.
	// It cannot detect a stall during the job.
	timedOut := time.After(perPulseTimeout * time.Duration(workUnits))

	collected := make([]int, 0, workUnits)

	for {
		select {
		case r, ok := <-results:
			if !ok {
				return collected, nil
			}
			collected = append(collected, r)

		case <-timedOut:
			return nil, fmt.Errorf("work timed out after %s", perPulseTimeout*time.Duration(workUnits))
		}
	}
}

func main() {
	start := time.Now()
	res, err := WorkWithTimeout(5, -1, 300*time.Millisecond)
	fmt.Printf("no-stall run: results=%v err=%v (took %s)\n", res, err, time.Since(start))

	start = time.Now()
	res, err = WorkWithTimeout(5, 2, 300*time.Millisecond)
	fmt.Printf("stalled run:  results=%v err=%v (took %s)\n", res, err, time.Since(start))
}
