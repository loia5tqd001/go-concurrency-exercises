package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// CallLatency is the duration of one successful call.
const CallLatency = 100 * time.Millisecond

// ErrTooManyConcurrentRequests means the API is at its concurrency limit.
var ErrTooManyConcurrentRequests = errors.New("too many concurrent requests")

// FlakyAPI rejects calls above maxConcurrent instead of queueing them.
// It records peak concurrency only for tests.
type FlakyAPI struct {
	mu            sync.Mutex
	current       int
	highWaterMark int
	maxConcurrent int
}

// NewFlakyAPI sets the API's concurrency limit.
func NewFlakyAPI(maxConcurrent int) *FlakyAPI {
	return &FlakyAPI{maxConcurrent: maxConcurrent}
}

// Call returns an error above the limit.
// Otherwise it sleeps for CallLatency and returns a fixed response.
func (a *FlakyAPI) Call(req string) (string, error) {
	a.mu.Lock()
	a.current++
	if a.current > a.highWaterMark {
		a.highWaterMark = a.current
	}
	tooMany := a.current > a.maxConcurrent
	a.mu.Unlock()

	if tooMany {
		a.mu.Lock()
		a.current--
		a.mu.Unlock()

		return "", ErrTooManyConcurrentRequests
	}

	time.Sleep(CallLatency)

	a.mu.Lock()
	a.current--
	a.mu.Unlock()

	return fmt.Sprintf("response-for-%s", req), nil
}

// HighWaterMark returns the largest number of observed calls in flight.
func (a *FlakyAPI) HighWaterMark() int {
	a.mu.Lock()
	defer a.mu.Unlock()

	return a.highWaterMark
}
