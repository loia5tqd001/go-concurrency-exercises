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

// MockReplica is a fake replica with a controllable delay.
// It records cancellation and completion.
type MockReplica struct {
	name    string
	value   string
	err     error
	latency time.Duration

	mu             sync.Mutex
	observedCancel bool
	completed      bool
}

// NewMockReplica returns a replica with the given name and delay.
func NewMockReplica(name string, latency time.Duration) *MockReplica {
	return &MockReplica{name: name, value: name, latency: latency}
}

// WithError makes the mock return err after its delay.
func (m *MockReplica) WithError(err error) *MockReplica {
	m.err = err
	return m
}

// Replica waits for its delay or until done closes.
// It records which event happened first.
func (m *MockReplica) Replica(done <-chan struct{}) (string, error) {
	timer := time.NewTimer(m.latency)
	defer timer.Stop()

	select {
	case <-timer.C:
		m.mu.Lock()
		m.completed = true
		m.mu.Unlock()
		return m.value, m.err

	case <-done:
		m.mu.Lock()
		m.observedCancel = true
		m.mu.Unlock()
		return "", nil
	}
}

// ObservedCancellation reports whether done stopped this replica.
func (m *MockReplica) ObservedCancellation() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.observedCancel
}

// RanToCompletion reports whether the full delay elapsed.
func (m *MockReplica) RanToCompletion() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}
