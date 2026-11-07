package main

import "time"

// ConsumeLatency is the duration of one slow consumption.
const ConsumeLatency = 50 * time.Millisecond

// SlowConsume sleeps for ConsumeLatency.
func SlowConsume(item int) {
	time.Sleep(ConsumeLatency)
}
