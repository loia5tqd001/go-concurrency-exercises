//////////////////////////////////////////////////////////////////////
//
// WordCount counts words across text chunks.
// The current code processes each chunk one at a time.
//
// Your task is to use map-reduce:
// map each chunk into its own local count, then merge the counts.
// Several goroutines must never write to the final map at once.
// Keep this signature:
//
//     func WordCount(chunks []string) map[string]int
//
// The tests use this exact signature.
//

package main

import (
	"fmt"
	"strings"
	"time"
)

// WordCount counts words in all chunks.
// It is sequential now.
func WordCount(chunks []string) map[string]int {
	result := make(map[string]int)

	for _, chunk := range chunks {
		time.Sleep(ProcessDelay)
		for _, word := range strings.Fields(chunk) {
			result[word]++
		}
	}

	return result
}

func main() {
	chunks := []string{
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

	start := time.Now()
	counts := WordCount(chunks)
	elapsed := time.Since(start)

	for word, count := range counts {
		fmt.Printf("%s: %d\n", word, count)
	}

	fmt.Printf("Counted %d distinct words across %d chunks in %s\n", len(counts), len(chunks), elapsed)
}
