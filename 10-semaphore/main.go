//////////////////////////////////////////////////////////////////////
//
// FetchAll is supposed to fetch every request in reqs from api (see
// mockapi.go), running enough of them concurrently to be fast, but
// never so many at once that the API starts rejecting calls with
// ErrTooManyConcurrentRequests - go over its budget and it fails
// requests instead of queuing them.
//
//   today (broken):                    goal:
//   12 requests, fired all at once     12 requests, gated to N in flight
//      │   │   │   │   │  ...             │   │   │   │   │  ...
//      ▼   ▼   ▼   ▼   ▼                  ▼   ▼   ▼   ▼   ▼
//   api.Call ×12 at once - blows        [ N slots ] - the rest queue
//   past the API's budget, most         here
//   come back ErrTooManyConcurrent            │
//   Requests                                  ▼
//                                        api.Call, one per slot - none
//                                        ever rejected, still running
//                                        in parallel
//
// Right now FetchAll does neither well: it fires off every request
// all at once with no concurrency limit whatsoever.
//
// Your task is to bound how many requests are in flight at once by
// implementing your OWN counting semaphore from scratch, using a
// buffered channel of struct{} - do not import
// golang.org/x/sync/semaphore or any other pre-built semaphore, the
// whole point of this exercise is to build one yourself.
//
// Pick a fixed cap that is strictly less than the API's own
// maxConcurrent budget (see NewFlakyAPI below), giving yourself
// headroom rather than riding the exact edge of it. At the same
// time, make sure requests are still dispatched concurrently rather
// than one at a time - the point of a semaphore is to cap
// concurrency, not eliminate it, so FetchAll should still be
// meaningfully faster than a sequential loop. Keep the function
// signature identical:
//
//     func FetchAll(api *FlakyAPI, reqs []string) []string
//
// so that it remains a drop-in replacement for the naive version
// below.
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// FetchAll fetches every request in reqs from api and returns the
// results in the same order as reqs, with "ERROR: <message>" in place
// of any request that failed. It currently fires off every request at
// once with no limit on how many are in flight simultaneously.
func FetchAll(api *FlakyAPI, reqs []string) []string {
	results := make([]string, len(reqs))
	var wg sync.WaitGroup

	for i, r := range reqs {
		wg.Add(1)
		go func(i int, r string) {
			defer wg.Done()

			res, err := api.Call(r)
			if err != nil {
				results[i] = "ERROR: " + err.Error()
				return
			}
			results[i] = res
		}(i, r)
	}

	wg.Wait()

	return results
}

func main() {
	api := NewFlakyAPI(3)

	reqs := make([]string, 12)
	for i := range reqs {
		reqs[i] = fmt.Sprintf("request-%d", i)
	}

	start := time.Now()
	results := FetchAll(api, reqs)
	elapsed := time.Since(start)

	for i, res := range results {
		fmt.Printf("%s -> %s\n", reqs[i], res)
	}

	fmt.Printf("Fetched %d requests in %s (API high-water mark: %d)\n",
		len(results), elapsed, api.HighWaterMark())
}
