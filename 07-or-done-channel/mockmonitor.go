package main

import "time"

// MetricInterval is the time between metric readings.
const MetricInterval = 20 * time.Millisecond

// StartMetricStream emits a counter forever and never closes its channel.
// The consumer must stop reading when it no longer needs values.
func StartMetricStream() <-chan int {
	out := make(chan int)

	go func() {
		counter := 0
		for {
			time.Sleep(MetricInterval)
			counter++
			out <- counter
		}
	}()

	return out
}
