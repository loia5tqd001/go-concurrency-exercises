//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"hash/fnv"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// expectedThumbnailData copies ProcessImage data logic without the sleep.
func expectedThumbnailData(url string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(url))

	return fmt.Sprintf("thumb-%x", h.Sum64())
}

func testURLs(n int) []string {
	urls := make([]string, n)
	for i := range urls {
		urls[i] = fmt.Sprintf("https://example.com/images/%d.jpg", i)
	}

	return urls
}

// TestGenerateThumbnailsCorrectness checks each URL appears once with right data.
// It does not depend on order or timing.
func TestGenerateThumbnailsCorrectness(t *testing.T) {
	urls := testURLs(10)

	got := GenerateThumbnails(urls)

	if len(got) != len(urls) {
		t.Fatalf("expected %d thumbnails, got %d", len(urls), len(got))
	}

	byURL := make(map[string]Thumbnail, len(got))
	for _, th := range got {
		if _, dup := byURL[th.URL]; dup {
			t.Errorf("URL %q appeared more than once in the result", th.URL)
		}
		byURL[th.URL] = th
	}

	for _, url := range urls {
		th, ok := byURL[url]
		if !ok {
			t.Errorf("missing thumbnail for URL %q", url)
			continue
		}
		if want := expectedThumbnailData(url); th.Data != want {
			t.Errorf("thumbnail data for %q = %q, want %q", url, th.Data, want)
		}
	}
}

// TestGenerateThumbnailsConcurrency checks that image work runs concurrently.
// Ten sequential calls take 1.5s. Concurrent calls take about 150ms.
// synctest uses a fake clock, so the timing check is stable.
// One goroutine per URL is enough.
func TestGenerateThumbnailsConcurrency(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		urls := testURLs(10)

		start := time.Now()
		got := GenerateThumbnails(urls)
		elapsed := time.Since(start)

		if len(got) != len(urls) {
			t.Fatalf("expected %d thumbnails, got %d", len(urls), len(got))
		}

		const sequentialTime = 10 * ProcessingLatency
		const budget = 500 * time.Millisecond

		if elapsed >= budget {
			t.Errorf("GenerateThumbnails took %s (sequential would take %s); "+
				"want well under %s - looks like URLs are being processed one at a time "+
				"instead of concurrently", elapsed, sequentialTime, budget)
		}
	})
}

// TestGenerateThumbnailsConcurrentCorrectness checks many URLs with the race detector.
// It looks for unsafe shared result storage.
func TestGenerateThumbnailsConcurrentCorrectness(t *testing.T) {
	urls := testURLs(50)

	got := GenerateThumbnails(urls)

	if len(got) != len(urls) {
		t.Fatalf("expected %d thumbnails, got %d", len(urls), len(got))
	}

	var mu sync.Mutex
	seen := make(map[string]bool, len(urls))

	var wg sync.WaitGroup
	for _, th := range got {
		th := th
		wg.Add(1)
		go func() {
			defer wg.Done()

			want := expectedThumbnailData(th.URL)

			mu.Lock()
			defer mu.Unlock()

			if seen[th.URL] {
				t.Errorf("URL %q appeared more than once in the result", th.URL)
			}
			seen[th.URL] = true

			if th.Data != want {
				t.Errorf("thumbnail data for %q = %q, want %q", th.URL, th.Data, want)
			}
		}()
	}
	wg.Wait()

	if len(seen) != len(urls) {
		t.Errorf("expected %d distinct URLs in result, got %d", len(urls), len(seen))
	}
}
