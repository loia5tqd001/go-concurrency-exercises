package main

import "time"

// SensorInterval is how long StartSensor waits between emitting two
// consecutive readings.
const SensorInterval = 5 * time.Millisecond

// StartSensor simulates a hardware sensor: it emits `count` incrementing
// integer readings (0, 1, 2, ...), one every SensorInterval, on the
// channel it returns, then closes that channel. Think of a temperature
// probe or an accelerometer streaming samples that need to reach more
// than one consumer - a live display AND a logger, say. Closing `done`
// stops it early, mid-stream, the same way a real sensor's driver would
// be told to shut down: the next tick and the next send are both
// abandoned rather than left to block forever on a reader that's gone.
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
