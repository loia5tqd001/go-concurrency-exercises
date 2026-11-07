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

// MockWard is a fake ward for steward tests.
// Each generation pulses once, then goes silent after a set count.
// It records generation count and the done channel for each one.
type MockWard struct {
	pulsesBeforeWedge int

	mu          sync.Mutex
	generations int
	dones       []<-chan struct{}
}

// NewMockWard returns a ward that wedges after the given pulse count.
func NewMockWard(pulsesBeforeWedge int) *MockWard {
	return &MockWard{pulsesBeforeWedge: pulsesBeforeWedge}
}

// Generations returns how many ward generations started.
func (w *MockWard) Generations() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.generations
}

// Dones returns each generation's done channel in start order.
func (w *MockWard) Dones() []<-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]<-chan struct{}(nil), w.dones...)
}

// Start begins one generation and returns its heartbeat.
// It pulses at pulseInterval until reaching the wedge count.
// Then it ignores done and leaves heartbeat open and silent.
func (w *MockWard) Start(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
	w.mu.Lock()
	w.generations++
	w.dones = append(w.dones, done)
	w.mu.Unlock()

	heartbeat := make(chan struct{}, 1)

	go func() {
		ticker := time.NewTicker(pulseInterval)
		defer ticker.Stop()

		pulses := 0
		for {
			select {
			case <-done:
				return

			case <-ticker.C:
				pulses++

				select {
				case heartbeat <- struct{}{}:
				default:
				}

				if pulses >= w.pulsesBeforeWedge {
					// Simulate a deadlock: stop without reading done.
					return
				}
			}
		}
	}()

	return heartbeat
}
