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

// TestRunPipelineProcessesAllItems checks that every item makes it
// through exactly once: produce and consume are each called exactly
// once per index in [0, itemCount). It makes no assumption about
// timing or how the producer and consumer are wired together, so it
// passes against both the naive unbounded-buffer implementation and a
// properly bounded one.
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

// TestRunPipelineAppliesBackpressure asserts that RunPipeline actually
// throttles the producer to (roughly) the consumer's pace instead of
// letting it race ahead and buffer the entire run in memory. Every
// time produce(i) fires, the test records how many items have already
// been fully consumed at that instant; the gap between the two
// (i - consumedSoFar) measures how far ahead of the consumer the
// producer has been allowed to get. consume itself owns the slow
// work (SlowConsume) here - RunPipeline has no idea it's even
// happening, which is exactly the point: it's just plumbing.
//
// With an unbounded channel (buffer = itemCount), the producer never
// has to wait for anything: it can - and does - produce every one of
// the 20 items before the consumer, which pays a real 50ms per item,
// has consumed even the first one. That makes the gap for the last
// item roughly 19.
//
// With a small, fixed-size channel buffer, the producer's send blocks
// as soon as the buffer (plus the one item the consumer may be
// actively processing) is full, so the gap stays small and bounded,
// regardless of itemCount.
//
// synctest.Test runs the body on a fake clock that jumps forward as
// soon as every goroutine in the bubble is durably blocked (e.g. the
// consumer asleep inside SlowConsume), so this is deterministic and
// doesn't flake on a busy machine.
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
