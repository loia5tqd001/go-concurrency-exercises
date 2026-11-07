//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"reflect"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// wordCountChunks returns the test chunks.
// Words repeat across chunks and within chunks.
// Counts must be added. Matching keys alone are not enough.
func wordCountChunks() []string {
	return []string{
		"the quick brown fox jumps over the lazy dog",
		"the dog barks at the fox",
		"brown fox and brown dog play",
		"quick quick quick fox",
		"lazy dog sleeps all day",
		"the cat and the dog are friends",
		"cat chases mouse mouse runs",
		"fox fox fox jumps high",
		"the sun is bright today",
		"bright sun warms the lazy cat",
	}
}

// expectedWordCountsFor10Chunks returns the known counts for the test chunks.
func expectedWordCountsFor10Chunks() map[string]int {
	return map[string]int{
		"all":     1,
		"and":     2,
		"are":     1,
		"at":      1,
		"barks":   1,
		"bright":  2,
		"brown":   3,
		"cat":     3,
		"chases":  1,
		"day":     1,
		"dog":     5,
		"fox":     7,
		"friends": 1,
		"high":    1,
		"is":      1,
		"jumps":   2,
		"lazy":    3,
		"mouse":   2,
		"over":    1,
		"play":    1,
		"quick":   4,
		"runs":    1,
		"sleeps":  1,
		"sun":     2,
		"the":     8,
		"today":   1,
		"warms":   1,
	}
}

// tallyWordCounts counts words without calling WordCount.
// The race test uses it for larger inputs.
func tallyWordCounts(chunks []string) map[string]int {
	want := make(map[string]int)
	for _, chunk := range chunks {
		for _, word := range strings.Fields(chunk) {
			want[word]++
		}
	}
	return want
}

// TestWordCountCorrectness checks the merged word counts.
func TestWordCountCorrectness(t *testing.T) {
	chunks := wordCountChunks()

	got := WordCount(chunks)
	want := expectedWordCountsFor10Chunks()

	if !reflect.DeepEqual(got, want) {
		t.Errorf("WordCount(chunks) = %v, want %v", got, want)
	}
}

// TestWordCountConcurrency checks that chunks run at the same time.
// Sequential work takes 10 * 30ms = 300ms.
// The test wants less than 100ms.
// synctest uses a fake clock, so this check is stable.
func TestWordCountConcurrency(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		chunks := wordCountChunks()

		start := time.Now()
		got := WordCount(chunks)
		elapsed := time.Since(start)

		want := expectedWordCountsFor10Chunks()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("WordCount(chunks) = %v, want %v", got, want)
		}

		const sequentialTime = 10 * ProcessDelay
		const budget = 100 * time.Millisecond

		if elapsed >= budget {
			t.Errorf("WordCount took %s (sequential would take %s); "+
				"want well under %s - looks like chunks are being processed one at a "+
				"time instead of concurrently", elapsed, sequentialTime, budget)
		}
	})
}

// TestWordCountRace repeats a larger input.
// Run it with `go test -race` to catch shared-map writes.
func TestWordCountRace(t *testing.T) {
	base := wordCountChunks()

	chunks := make([]string, 0, 3*len(base))
	for i := 0; i < 3; i++ {
		chunks = append(chunks, base...)
	}

	want := tallyWordCounts(chunks)

	for i := 0; i < 5; i++ {
		got := WordCount(chunks)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("run %d: WordCount(chunks) = %v, want %v", i, got, want)
		}
	}
}
