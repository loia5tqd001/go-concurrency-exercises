//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"testing"
	"time"
)

// readings mixes valid, invalid, and zero values.
// Good values after bad ones catch early exit.
//
//	index:   0     1      2    3    4     5      6    7
//	value:  "10" "abc"   "5"  "0"  "-3"  "xyz"  "0"  "7"
//	kind:    ok   parse   ok  div   ok   parse   div   ok
//	              err          0                       0
var readings = []string{"10", "abc", "5", "0", "-3", "xyz", "0", "7"}

// goodIndex maps successful readings to their values.
var goodIndex = map[int]int{
	0: 10,
	2: 5,
	4: -3,
	7: 7,
}

// parseErrIndex marks values that are not integers.
var parseErrIndex = map[int]bool{
	1: true,
	5: true,
}

// divZeroIndex marks valid readings that are zero.
var divZeroIndex = map[int]bool{
	3: true,
	6: true,
}

// TestAllReadingsProduceResults checks the result count.
// It must equal the input count.
func TestAllReadingsProduceResults(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	got := ProcessReadings(done, readings)

	if len(got) != len(readings) {
		t.Fatalf("ProcessReadings(%d readings) returned %d results, want %d - "+
			"looks like the pipeline aborted early instead of reporting "+
			"each bad reading and continuing", len(readings), len(got), len(readings))
	}
}

// TestGoodReadingsSucceed checks valid readings.
func TestGoodReadingsSucceed(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	got := ProcessReadings(done, readings)

	for idx, wantValue := range goodIndex {
		if len(got) <= idx {
			t.Fatalf("no result for reading %d (%q): pipeline aborted early "+
				"instead of reporting the error and continuing", idx, readings[idx])
		}
		res := got[idx]
		if res.Err != nil {
			t.Errorf("reading %d (%q): expected no error, got %v", idx, readings[idx], res.Err)
		}
		if res.Value != wantValue {
			t.Errorf("reading %d (%q): expected Value %d, got %d", idx, readings[idx], wantValue, res.Value)
		}
	}
}

// TestBadReadingsCarryErrors checks every bad reading.
// Each must return a non-nil Err.
func TestBadReadingsCarryErrors(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	got := ProcessReadings(done, readings)

	for idx := range parseErrIndex {
		if len(got) <= idx {
			t.Fatalf("no result for reading %d (%q): pipeline aborted early "+
				"instead of reporting the error and continuing", idx, readings[idx])
		}
		res := got[idx]
		if res.Err == nil {
			t.Errorf("reading %d (%q): expected a parse error, got Err == nil", idx, readings[idx])
		}
		if errors.Is(res.Err, ErrDivideByZero) {
			t.Errorf("reading %d (%q): got ErrDivideByZero, want a parse error - "+
				"reciprocal must never overwrite an existing (parse) error, and a "+
				"failed parse's Value defaults to 0 which must NOT be re-validated "+
				"as a divide-by-zero", idx, readings[idx])
		}
		if res.Value != 0 {
			t.Errorf("reading %d (%q): expected Value 0 on a parse failure, got %d", idx, readings[idx], res.Value)
		}
	}

	for idx := range divZeroIndex {
		if len(got) <= idx {
			t.Fatalf("no result for reading %d (%q): pipeline aborted early "+
				"instead of reporting the error and continuing", idx, readings[idx])
		}
		if !errors.Is(got[idx].Err, ErrDivideByZero) {
			t.Errorf("reading %d (%q): expected ErrDivideByZero, got %v", idx, readings[idx], got[idx].Err)
		}
	}
}

// TestProcessingContinuesPastBadReadings checks later valid readings.
// They must still appear after errors.
func TestProcessingContinuesPastBadReadings(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	got := ProcessReadings(done, readings)

	afterABadOne := []int{2, 4, 7}
	for _, idx := range afterABadOne {
		if len(got) <= idx {
			t.Fatalf("no result for reading %d (%q), which comes after a bad reading: "+
				"the pipeline stopped processing instead of continuing past the error", idx, readings[idx])
		}
		res := got[idx]
		if res.Err != nil {
			t.Errorf("reading %d (%q) after a bad reading: expected no error, got %v", idx, readings[idx], res.Err)
		}
		if res.Value != goodIndex[idx] {
			t.Errorf("reading %d (%q) after a bad reading: expected Value %d, got %d", idx, readings[idx], goodIndex[idx], res.Value)
		}
	}
}

// doneReadings gives the cancellation tests work in flight.
var doneReadings = []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}

// pipelineStopsPromptlyOnDone controls when the pipeline can send.
// It reads one result, stops reading, then closes done.
// The output must close without hanging.
// Fewer than all results should get through.
func pipelineStopsPromptlyOnDone(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	out := reciprocal(done, parse(done, doneReadings))

	select {
	case _, ok := <-out:
		if !ok {
			t.Fatal("pipeline closed its output before producing a single result")
		}
	case <-time.After(1 * time.Second):
		t.Fatal("pipeline never produced a first result")
	}
	drained := 1

	// Let both stages block on output before done closes.
	time.Sleep(20 * time.Millisecond)

	close(done)

	for {
		select {
		case _, ok := <-out:
			if !ok {
				if drained >= len(doneReadings) {
					t.Errorf("pipeline drained all %d readings after done was closed - "+
						"expected done to cut the batch short instead of letting it run to completion", drained)
				}
				return
			}
			drained++
			if drained >= len(doneReadings) {
				t.Fatal("pipeline kept producing results well past done being closed instead of stopping promptly")
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatal("pipeline did not stop promptly after done was closed - a stage appears to be leaked, " +
				"blocked forever on a send that ignores done")
		}
	}
}

// TestPipelineStopsPromptlyOnDone checks that done stops both stages.
func TestPipelineStopsPromptlyOnDone(t *testing.T) {
	pipelineStopsPromptlyOnDone(t)
}

// TestPipelineNoGoroutineLeakRace repeats the shutdown test.
// Run it with `go test -race`.
func TestPipelineNoGoroutineLeakRace(t *testing.T) {
	for i := 0; i < 10; i++ {
		pipelineStopsPromptlyOnDone(t)
	}
}
