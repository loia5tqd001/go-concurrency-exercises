package main

import (
	"fmt"
	"hash/fnv"
	"time"
)

// ProcessingLatency is the time one image takes to process.
const ProcessingLatency = 150 * time.Millisecond

// Thumbnail is the result for one image URL.
type Thumbnail struct {
	URL  string
	Data string
}

// ProcessImage returns fixed fake data after ProcessingLatency.
// The same URL always gets the same data.
func ProcessImage(url string) Thumbnail {
	time.Sleep(ProcessingLatency)

	h := fnv.New64a()
	_, _ = h.Write([]byte(url))

	return Thumbnail{
		URL:  url,
		Data: fmt.Sprintf("thumb-%x", h.Sum64()),
	}
}
