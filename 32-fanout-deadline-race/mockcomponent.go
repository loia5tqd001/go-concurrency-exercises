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

// MockComponent is a component with a fixed delay.
// It cannot observe a context.
// It records whether the component finished.
type MockComponent struct {
	value   string
	latency time.Duration

	mu        sync.Mutex
	completed bool
}

// NewMockComponent returns a component with the given value and delay.
func NewMockComponent(value string, latency time.Duration) *MockComponent {
	return &MockComponent{value: value, latency: latency}
}

// Component runs the mock. Pass it directly to Construct.
// It always waits for the full delay.
func (m *MockComponent) Component() string {
	time.Sleep(m.latency)

	m.mu.Lock()
	m.completed = true
	m.mu.Unlock()

	return m.value
}

// RanToCompletion reports whether Component finished.
func (m *MockComponent) RanToCompletion() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}
