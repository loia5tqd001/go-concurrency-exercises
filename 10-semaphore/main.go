//////////////////////////////////////////////////////////////////////
//
// Fetch requests fast, but keep calls under the API's limit.
// The naive version starts every request at once.
// Build a counting semaphore from a buffered chan struct{}.
// Do not use an imported semaphore.
// Keep the fixed limit below NewFlakyAPI's maxConcurrent budget.
// Keep requests concurrent; do not make them sequential.
//
//     func FetchAll(api *FlakyAPI, reqs []string) []string
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// FetchAll returns one result per request in input order.
// Failed calls are returned as "ERROR: <message>".
// The naive version has no concurrency limit.
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
