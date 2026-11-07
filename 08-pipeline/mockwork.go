package main

import "time"

// WorkLatency is the time one pipeline item takes to process.
const WorkLatency = 10 * time.Millisecond

// SimulateWork sleeps for WorkLatency.
func SimulateWork() {
	time.Sleep(WorkLatency)
}
