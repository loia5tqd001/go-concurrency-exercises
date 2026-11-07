//////////////////////////////////////////////////////////////////////
//
// GenerateThumbnails creates one thumbnail for each image URL.
// ProcessImage simulates slow image work with a fixed sleep.
//
// The current loop handles one URL at a time.
// Ten images therefore take ten times one image's time.
//
// Change the function to process URLs concurrently.
// Return one result per URL. Do not drop, repeat, or race.
// Keep this signature:
//
//     func GenerateThumbnails(urls []string) []Thumbnail
//
// One goroutine per URL with sync.WaitGroup is enough.
// Later exercises cover bounded concurrency.
//

package main

import (
	"fmt"
	"time"
)

// GenerateThumbnails creates a thumbnail for every URL.
// It currently processes one URL at a time.
func GenerateThumbnails(urls []string) []Thumbnail {
	thumbnails := make([]Thumbnail, 0, len(urls))

	for _, url := range urls {
		thumbnails = append(thumbnails, ProcessImage(url))
	}

	return thumbnails
}

func main() {
	urls := []string{
		"https://example.com/images/1.jpg",
		"https://example.com/images/2.jpg",
		"https://example.com/images/3.jpg",
		"https://example.com/images/4.jpg",
		"https://example.com/images/5.jpg",
		"https://example.com/images/6.jpg",
		"https://example.com/images/7.jpg",
		"https://example.com/images/8.jpg",
	}

	start := time.Now()
	thumbnails := GenerateThumbnails(urls)
	elapsed := time.Since(start)

	for _, t := range thumbnails {
		fmt.Printf("%s -> %s\n", t.URL, t.Data)
	}

	fmt.Printf("Generated %d thumbnails in %s\n", len(thumbnails), elapsed)
}
