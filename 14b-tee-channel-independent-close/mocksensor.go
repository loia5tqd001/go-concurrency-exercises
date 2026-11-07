package main

import "time"

// SensorInterval is the delay between readings.
const SensorInterval = 5 * time.Millisecond

// StartSensor emits 0 through count-1, then closes its channel.
// Closing done stops the sensor before the next tick or send.
func StartSensor(done <-chan struct{}, count int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for i := 0; i < count; i++ {
			select {
			case <-time.After(SensorInterval):
			case <-done:
				return
			}

			select {
			case out <- i:
			case <-done:
				return
			}
		}
	}()

	return out
}
