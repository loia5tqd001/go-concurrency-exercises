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

// MockHandler is a test/demo helper that builds a handler function
// with a configurable artificial latency, matching the func() (string,
// error) signature Serve accepts - deliberately with no ctx parameter,
// since the whole point of this exercise is that a handler like this
// has no way to cooperatively notice a cancellation. It exposes -
// after the fact - whether that particular call ran all the way to
// completion.
type MockHandler struct {
	value   string
	err     error
	latency time.Duration

	mu        sync.Mutex
	completed bool
}

// NewMockHandler creates a MockHandler that, once wired up via its
// Handler method, blocks for latency (simulating real, ctx-blind work)
// before returning value with a nil error.
func NewMockHandler(value string, latency time.Duration) *MockHandler {
	return &MockHandler{value: value, latency: latency}
}

// WithError makes the mock return err instead of a nil error once its
// artificial latency elapses.
func (m *MockHandler) WithError(err error) *MockHandler {
	m.err = err
	return m
}

// Handler is the func() (string, error) backed by this mock - pass
// m.Handler straight into Serve. It unconditionally sleeps for
// m.latency and then returns - it has no ctx parameter, so it cannot
// be told to stop early no matter how long it runs.
func (m *MockHandler) Handler() (string, error) {
	time.Sleep(m.latency)

	m.mu.Lock()
	m.completed = true
	m.mu.Unlock()

	return m.value, m.err
}

// RanToCompletion reports whether this handler's artificial latency
// fully elapsed and it returned its result, regardless of whether
// anyone was still around to receive it.
func (m *MockHandler) RanToCompletion() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}
