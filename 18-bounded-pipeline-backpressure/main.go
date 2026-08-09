//////////////////////////////////////////////////////////////////////
//
// Given is a fast producer feeding a slow consumer. RunPipeline is
// supposed to stream items from the producer to the consumer through
// a BOUNDED channel, so that if the consumer falls behind, the
// producer is forced to slow down too (backpressure) instead of
// piling up unboundedly-buffered, unconsumed work in memory. Right
// now it does the opposite: it produces every item into an in-memory
// slice up front - calling produce(i) for every one of them - before
// the consumer gets to touch a single item, so the "fast producer,
// slow consumer" mismatch never actually pushes back on the producer
// at all; it just silently buffers the entire run in memory and runs
// everything sequentially.
//
// RunPipeline doesn't know what an item actually is, or what "slow"
// means - both are entirely up to the caller. produce(i) generates
// item i and returns it; consume(item) is handed that value and does
// whatever expensive work it wants with it (in main below, and in
// this exercise's tests, that's SlowConsume - see
// mockslowconsumer.go), simulating a slow downstream sink (e.g.
// writing to a remote store) by sleeping for 50ms per item. produce
// and consume, both provided by the caller, must be called exactly
// once per item (produce(i) right when item i is generated, consume
// right when the item it returned is handed off) so tests can observe
// the gap between how far ahead production has gotten versus
// consumption. produce and consume may be called from different
// goroutines - the caller-supplied callbacks in the tests do their
// own synchronization (a mutex), so RunPipeline itself doesn't need
// to worry about that; it just needs to call them at the right
// moments.
//
// Your task is to rewrite RunPipeline so production and consumption
// run concurrently, connected by a channel with a small, fixed buffer
// (e.g. size 2) instead of collecting everything into a slice up
// front: start a goroutine that produces items and sends them on the
// channel, closing the channel once it's done, while the consumer
// ranges over the channel calling consume for each item it receives.
// Once the buffer (plus the one item the consumer may be actively
// processing) is full, the producer's next send must block until the
// consumer drains an item - i.e. real backpressure. The function
// signature must stay the same:
//
//     func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T))
//

package main

import "fmt"

// RunPipeline streams itemCount items (0..itemCount-1) from a fast
// producer to a slow consumer. For now it produces every item up
// front into an in-memory slice, so the consumer never gets to push
// back on the producer.
func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T)) {
	items := make([]T, 0, itemCount)
	for i := 0; i < itemCount; i++ {
		items = append(items, produce(i))
	}

	for _, item := range items {
		consume(item)
	}
}

func main() {
	RunPipeline(20, func(i int) int {
		fmt.Println("produced", i)
		return i
	}, func(item int) {
		SlowConsume(item)
		fmt.Println("consumed", item)
	})
}
