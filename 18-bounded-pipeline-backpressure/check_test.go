//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"testing"
	"testing/synctest"
)

// TestRunPipelineProcessesAllItems checks every item once.
// Produce and consume must each run once per index.
func TestRunPipelineProcessesAllItems(t *testing.T) {
	const itemCount = 20

	var mu sync.Mutex
	producedCount := make(map[int]int, itemCount)
	consumedCount := make(map[int]int, itemCount)

	RunPipeline(itemCount,
		func(i int) int {
			mu.Lock()
			defer mu.Unlock()
			producedCount[i]++
			return i
		},
		func(item int) {
			mu.Lock()
			defer mu.Unlock()
			consumedCount[item]++
		},
	)

	for i := 0; i < itemCount; i++ {
		if got := producedCount[i]; got != 1 {
			t.Errorf("produce(%d) called %d times, want exactly 1", i, got)
		}
		if got := consumedCount[i]; got != 1 {
			t.Errorf("consume(%d) called %d times, want exactly 1", i, got)
		}
	}
}

// TestRunPipelineAppliesBackpressure measures how far production runs ahead.
// A bounded buffer must keep that gap small.
// synctest makes the timing check deterministic.
func TestRunPipelineAppliesBackpressure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const itemCount = 20

		var mu sync.Mutex
		consumedSoFar := 0
		gapAtProduce := make([]int, itemCount)

		RunPipeline(itemCount,
			func(i int) int {
				mu.Lock()
				gapAtProduce[i] = i - consumedSoFar
				mu.Unlock()
				return i
			},
			func(item int) {
				SlowConsume(item)
				mu.Lock()
				consumedSoFar++
				mu.Unlock()
			},
		)

		maxGap := 0
		for _, gap := range gapAtProduce {
			if gap > maxGap {
				maxGap = gap
			}
		}

		const maxAllowedGap = 5
		if maxGap > maxAllowedGap {
			t.Errorf("max gap between how far production got ahead of consumption = %d, "+
				"want <= %d - looks like the producer is racing ahead of the slow "+
				"consumer instead of being throttled by a small, bounded channel "+
				"(backpressure)", maxGap, maxAllowedGap)
		}
	})
}
