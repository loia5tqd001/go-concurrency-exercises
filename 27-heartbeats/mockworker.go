//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"time"
)

// UnitDuration is the time for one healthy unit.
const UnitDuration = 400 * time.Millisecond

// StallDuration represents a worker stuck in one long wait.
// It never checks in until the wait ends.
const StallDuration = 24 * time.Hour

var (
	stallMu    sync.Mutex
	stallIndex = -1
)

// SetStallUnit sets the unit that will stall.
// Use a negative or out-of-range value to disable stalls.
// The setting is shared by all callers.
func SetStallUnit(index int) {
	stallMu.Lock()
	stallIndex = index
	stallMu.Unlock()
}

func isStallUnit(index int) bool {
	stallMu.Lock()
	defer stallMu.Unlock()
	return index == stallIndex
}

// SimulateUnit runs one work unit.
// A healthy unit calls checkIn between short waits.
// A stalled unit waits once and never calls checkIn.
// It returns false if done or checkIn asks it to stop.
func SimulateUnit(done <-chan struct{}, unitIndex int, pulseInterval time.Duration, checkIn func() bool) bool {
	if isStallUnit(unitIndex) {
		timer := time.NewTimer(StallDuration)
		defer timer.Stop()

		select {
		case <-timer.C:
			return true
		case <-done:
			return false
		}
	}

	remaining := UnitDuration
	for remaining > 0 {
		slice := pulseInterval
		if slice > remaining {
			slice = remaining
		}

		timer := time.NewTimer(slice)
		select {
		case <-timer.C:
		case <-done:
			timer.Stop()
			return false
		}
		timer.Stop()

		remaining -= slice
		if remaining > 0 {
			if !checkIn() {
				return false
			}
		}
	}

	return true
}
