//////////////////////////////////////////////////////////////////////
//
// StartMetricStream emits a metric every 20ms and never closes.
// A consumer may stop early by closing done.
//
// orDone must forward values until done closes.
// Then it must close its output and exit.
// Both receives and sends can block.
// Guard both with a select on done.
//
// Keep this signature:
//
//     func orDone(done <-chan struct{}, c <-chan int) <-chan int
//
// The current version returns c unchanged.
//

package main

import (
	"fmt"
	"time"
)

// orDone returns c without watching done.
// Closing done therefore has no effect.
func orDone(done <-chan struct{}, c <-chan int) <-chan int {
	return c
}

func main() {
	done := make(chan struct{})
	stream := StartMetricStream()
	out := orDone(done, stream)

	count := 0
	for v := range out {
		fmt.Println("metric:", v)
		count++
		if count == 5 {
			close(done)
			break
		}
	}
	fmt.Println("done reading, done closed - checking whether orDone actually stopped...")

	// Wait briefly for out to close after done closes.
	select {
	case v, ok := <-out:
		if ok {
			fmt.Println("unexpected: got a value after done closed:", v)
		} else {
			fmt.Println("OK: out closed promptly after done was closed - no leak")
		}
	case <-time.After(200 * time.Millisecond):
		fmt.Println("BUG: out did not close within 200ms of done closing - orDone leaked the forwarding goroutine")
	}
}
