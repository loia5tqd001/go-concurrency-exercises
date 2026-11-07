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

// MockHandler is a handler with a fixed delay.
// It cannot observe a context.
// It also records whether the handler finished.
type MockHandler struct {
	value   string
	err     error
	latency time.Duration

	mu        sync.Mutex
	completed bool
}

// NewMockHandler returns a handler with the given value and delay.
func NewMockHandler(value string, latency time.Duration) *MockHandler {
	return &MockHandler{value: value, latency: latency}
}

// WithError makes the handler return err after its delay.
func (m *MockHandler) WithError(err error) *MockHandler {
	m.err = err
	return m
}

// Handler runs the mock. Pass it directly to Serve.
// It always waits for the full delay.
func (m *MockHandler) Handler() (string, error) {
	time.Sleep(m.latency)

	m.mu.Lock()
	m.completed = true
	m.mu.Unlock()

	return m.value, m.err
}

// RanToCompletion reports whether Handler finished.
func (m *MockHandler) RanToCompletion() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}
