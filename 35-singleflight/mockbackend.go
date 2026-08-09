package main

import (
	"errors"
	"hash/fnv"
	"strings"
	"sync"
	"time"
)

// CallLatency is how long a single call to Call takes. It stands in
// for whatever slow backend work a real call would do (a database
// query, an upstream RPC, a cache-cold lookup, ...).
const CallLatency = 150 * time.Millisecond

// ErrUnavailable is returned by Call for any key with the "err-"
// prefix, standing in for a backend that's temporarily failing for a
// particular request.
var ErrUnavailable = errors.New("backend unavailable")

// callCounts, protected by callCountsMu, lets tests verify how many
// times the underlying backend actually ran for a given key.
var (
	callCountsMu sync.Mutex
	callCounts   = map[string]int{}
)

// Call simulates a slow backend call for key: it sleeps for
// CallLatency, then either returns a deterministic, key-derived
// result, or - for any key starting with "err-" - returns
// ErrUnavailable instead. Every invocation increments a per-key call
// counter, regardless of whether it succeeds or fails.
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

// CallCount returns how many times Call has actually run for key
// since the last ResetCallCounts.
func CallCount(key string) int {
	callCountsMu.Lock()
	defer callCountsMu.Unlock()

	return callCounts[key]
}

// ResetCallCounts resets every key's call counter. It is a test-only
// helper for isolating call counts between test cases.
func ResetCallCounts() {
	callCountsMu.Lock()
	callCounts = map[string]int{}
	callCountsMu.Unlock()
}
