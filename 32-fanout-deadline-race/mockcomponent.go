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

// MockComponent is a test/demo helper that builds a Component with a
// configurable artificial latency, and exposes - after the fact -
// whether that particular call ran all the way to completion. Like
// the real components Construct fans out to, its Component method has
// no ctx parameter, so it cannot be told to stop early once started.
type MockComponent struct {
	value   string
	latency time.Duration

	mu        sync.Mutex
	completed bool
}

// NewMockComponent creates a MockComponent that, once wired up via its
// Component method, blocks for latency (simulating real, ctx-blind
// work) before returning value.
func NewMockComponent(value string, latency time.Duration) *MockComponent {
	return &MockComponent{value: value, latency: latency}
}

// Component is the Component function backed by this mock - pass
// m.Component straight into Construct as one of its four components.
// It unconditionally sleeps for m.latency and then returns - it has
// no way to notice a deadline elapsing, no matter how long it runs.
func (m *MockComponent) Component() string {
	time.Sleep(m.latency)

	m.mu.Lock()
	m.completed = true
	m.mu.Unlock()

	return m.value
}

// RanToCompletion reports whether this component's artificial latency
// fully elapsed and it returned its value, regardless of whether
// Construct was still around to use it.
func (m *MockComponent) RanToCompletion() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}
