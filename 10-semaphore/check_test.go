//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func testReqs(n int) []string {
	reqs := make([]string, n)
	for i := range reqs {
		reqs[i] = fmt.Sprintf("request-%d", i)
	}

	return reqs
}

// TestFetchAllCorrectness checks every request succeeds.
// The API has enough headroom, so the limit cannot cause errors.
func TestFetchAllCorrectness(t *testing.T) {
	api := NewFlakyAPI(100)
	reqs := testReqs(10)

	got := FetchAll(api, reqs)

	if len(got) != len(reqs) {
		t.Fatalf("expected %d results, got %d", len(reqs), len(got))
	}

	for i, res := range got {
		if strings.HasPrefix(res, "ERROR:") {
			t.Errorf("result for %q = %q, want a successful response", reqs[i], res)
		}
		if want := fmt.Sprintf("response-for-%s", reqs[i]); res != want {
			t.Errorf("result for %q = %q, want %q", reqs[i], res, want)
		}
	}
}

// TestFetchAllRespectsSemaphoreLimit gives the API a limit of 3.
// FetchAll must stay below that limit and return no errors.
func TestFetchAllRespectsSemaphoreLimit(t *testing.T) {
	const apiMaxConcurrent = 3
	const wantMaxHighWaterMark = 2

	api := NewFlakyAPI(apiMaxConcurrent)
	reqs := testReqs(12)

	got := FetchAll(api, reqs)

	if len(got) != len(reqs) {
		t.Fatalf("expected %d results, got %d", len(reqs), len(got))
	}

	if hwm := api.HighWaterMark(); hwm > wantMaxHighWaterMark {
		t.Errorf("API high-water mark = %d, want <= %d; FetchAll is not "+
			"bounding its own concurrency strictly below the API's limit of %d",
			hwm, wantMaxHighWaterMark, apiMaxConcurrent)
	}

	for i, res := range got {
		if strings.HasPrefix(res, "ERROR:") {
			t.Errorf("result for %q = %q; a properly bounded FetchAll should "+
				"never trip the API's own rejection logic", reqs[i], res)
		}
	}
}

// TestFetchAllStillConcurrent rejects a sequential implementation.
// synctest gives this timing check a stable fake clock.
func TestFetchAllStillConcurrent(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api := NewFlakyAPI(100)
		reqs := testReqs(10)

		start := time.Now()
		got := FetchAll(api, reqs)
		elapsed := time.Since(start)

		if len(got) != len(reqs) {
			t.Fatalf("expected %d results, got %d", len(reqs), len(got))
		}

		const sequentialTime = 10 * CallLatency
		const budget = 600 * time.Millisecond

		if elapsed >= budget {
			t.Errorf("FetchAll took %s (sequential would take %s); want well "+
				"under %s - looks like requests are being made one at a time "+
				"instead of concurrently", elapsed, sequentialTime, budget)
		}
	})
}
