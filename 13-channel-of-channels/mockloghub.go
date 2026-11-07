//////////////////////////////////////////////////////////////////////
//
// This file simulates a log hub. Do not change it.
//

package main

import (
	"fmt"
	"time"
)

// StartLogHub emits one channel per shard over time.
// It closes the outer channel after starting numShards shards.
func StartLogHub(numShards, linesPerShard int) <-chan (<-chan string) {
	shardStream := make(chan (<-chan string))

	go func() {
		defer close(shardStream)

		for shardIdx := range numShards {
			lines := make(chan string)

			go func(shardIdx int) {
				defer close(lines)

				for i := range linesPerShard {
					time.Sleep(10 * time.Millisecond)
					lines <- fmt.Sprintf("shard-%d-line-%d", shardIdx, i)
				}
			}(shardIdx)

			shardStream <- lines

			// Start new shards over time.
			time.Sleep(5 * time.Millisecond)
		}
	}()

	return shardStream
}
