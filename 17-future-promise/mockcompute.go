package main

import (
	"hash/fnv"
	"sync"
	"time"
)

// ComputeLatency is the duration of one simulated computation.
const ComputeLatency = 150 * time.Millisecond

// callCount records computation calls for tests.
var (
	callCountMu sync.Mutex
	callCount   int
)

// ComputeExpensive sleeps, records one call, then returns a value from key.
func ComputeExpensive(key string) int {
	time.Sleep(ComputeLatency)

	callCountMu.Lock()
	callCount++
	callCountMu.Unlock()

	h := fnv.New64a()
	_, _ = h.Write([]byte(key))

	return int(h.Sum64() % 1_000_000)
}

// CallCount returns the number of computations since the last reset.
func CallCount() int {
	callCountMu.Lock()
	defer callCountMu.Unlock()

	return callCount
}

// ResetCallCount clears the computation counter.
func ResetCallCount() {
	callCountMu.Lock()
	callCount = 0
	callCountMu.Unlock()
}
