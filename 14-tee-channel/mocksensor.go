package main

import "time"

// SensorInterval is the delay between readings.
const SensorInterval = 5 * time.Millisecond

// StartSensor emits 0 through count-1, then closes its channel.
func StartSensor(count int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for i := 0; i < count; i++ {
			time.Sleep(SensorInterval)
			out <- i
		}
	}()

	return out
}
