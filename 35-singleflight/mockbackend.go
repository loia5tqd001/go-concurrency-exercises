package main

import (
	"errors"
	"hash/fnv"
	"strings"
	"sync"
	"time"
)

// CallLatency is the delay for one backend call.
const CallLatency = 150 * time.Millisecond

// ErrUnavailable is returned for keys that start with "err-".
var ErrUnavailable = errors.New("backend unavailable")

// callCounts records how often Call ran for each key.
// callCountsMu protects the map.
var (
	callCountsMu sync.Mutex
	callCounts   = map[string]int{}
)

// Call simulates slow backend work.
// It counts every call, including failed calls.
// Keys that start with "err-" return ErrUnavailable.
func Call(key string) (int, error) {
	time.Sleep(CallLatency)

	callCountsMu.Lock()
	callCounts[key]++
	callCountsMu.Unlock()

	if strings.HasPrefix(key, "err-") {
		return 0, ErrUnavailable
	}

	h := fnv.New64a()
	_, _ = h.Write([]byte(key))

	return int(h.Sum64() % 1_000_000), nil
}

// CallCount returns how often Call ran for key.
func CallCount(key string) int {
	callCountsMu.Lock()
	defer callCountsMu.Unlock()

	return callCounts[key]
}

// ResetCallCounts clears every key's call count.
func ResetCallCounts() {
	callCountsMu.Lock()
	callCounts = map[string]int{}
	callCountsMu.Unlock()
}
