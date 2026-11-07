//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"reflect"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// rangeNums returns all integers from 1 through n.
func rangeNums(n int) []int {
	nums := make([]int, n)
	for i := range nums {
		nums[i] = i + 1
	}
	return nums
}

// TestPipelineCorrectness checks the final result and order.
// It does not depend on timing.
func TestPipelineCorrectness(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	got := Pipeline(done, rangeNums(10)...)
	want := []int{4, 16, 36, 64, 100}

	if !reflect.DeepEqual(got, want) {
		t.Errorf("Pipeline(1..10) = %v, want %v", got, want)
	}
}

// TestPipelineStagesOverlap checks that all stages work at the same time.
// Batch processing takes about three full passes over the input.
// A real pipeline finishes in about one pass.
// synctest makes the timing check stable.
func TestPipelineStagesOverlap(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		nums := rangeNums(20)

		done := make(chan struct{})
		defer close(done)

		start := time.Now()
		got := Pipeline(done, nums...)
		elapsed := time.Since(start)

		wantLen := 0
		for _, n := range nums {
			if sq := n * n; sq%2 == 0 {
				wantLen++
			}
		}
		if len(got) != wantLen {
			t.Fatalf("Pipeline returned %d results, want %d", len(got), wantLen)
		}

		const budget = 250 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("Pipeline took %s to process %d items; want well under %s - "+
				"looks like generator, square, and keepEven are running one at a "+
				"time over the whole batch instead of overlapping as a pipeline",
				elapsed, len(nums), budget)
		}
	})
}

// TestPipelineStopsEarly closes done soon after Pipeline starts.
// A correct pipeline returns quickly and ignores the large input.
// synctest makes the large input cost no real time.
func TestPipelineStopsEarly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const hugeInput = 100
		nums := rangeNums(hugeInput)

		done := make(chan struct{})

		go func() {
			// Let at least one item pass before closing done.
			time.Sleep(WorkLatency)
			close(done)
		}()

		start := time.Now()
		Pipeline(done, nums...)
		elapsed := time.Since(start)

		const budget = 200 * time.Millisecond
		if elapsed >= budget {
			t.Errorf("Pipeline took %s to return after done was closed while "+
				"processing %d items; want well under %s - looks like the "+
				"pipeline keeps working through the entire input instead of "+
				"stopping once done fires", elapsed, hugeInput, budget)
		}

		// Wait for upstream stages to notice done and exit.
		// synctest reports a sleeping goroutine when the test returns.
		// Fake time makes this cleanup fast.
		time.Sleep(10 * time.Second)
	})
}

// TestPipelineConcurrentUse runs many Pipelines at once.
// The race detector can then find shared stage state.
// Each call has its own done channel and goroutines.
func TestPipelineConcurrentUse(t *testing.T) {
	const calls = 10
	want := []int{4, 16, 36, 64, 100}

	var wg sync.WaitGroup
	for i := 0; i < calls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			done := make(chan struct{})
			defer close(done)

			got := Pipeline(done, rangeNums(10)...)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("Pipeline(1..10) = %v, want %v", got, want)
			}
		}()
	}
	wg.Wait()
}
