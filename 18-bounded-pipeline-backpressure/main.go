//////////////////////////////////////////////////////////////////////
//
// Stream items from a fast producer to a slow consumer.
// Use a small bounded channel so a full buffer blocks the producer.
// Call produce once for each item.
// Call consume once for each received item.
//
//     func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T))
//

package main

import "fmt"

// RunPipeline should stream items with bounded buffering.
// The naive version collects every item before consuming any.
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
