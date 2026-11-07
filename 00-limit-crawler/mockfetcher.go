//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import "fmt"

// MockFetcher returns fixed pages from the Go concurrency tour.
type MockFetcher map[string]*mockResult

type mockResult struct {
	body string
	urls []string
}

// Fetch returns a page and its links.
func (f MockFetcher) Fetch(url string) (string, []string, error) {
	fetchSignalInstance() <- true
	if res, ok := f[url]; ok {
		return res.body, res.urls, nil
	}
	return "", nil, fmt.Errorf("not found: %s", url)
}

// fetcher holds the pages for this exercise.
var fetcher = MockFetcher{
	"http://golang.org/": &mockResult{
		"The Go Programming Language",
		[]string{
			"http://golang.org/pkg/",
			"http://golang.org/cmd/",
		},
	},
	"http://golang.org/pkg/": &mockResult{
		"Packages",
		[]string{
			"http://golang.org/",
			"http://golang.org/cmd/",
			"http://golang.org/pkg/fmt/",
			"http://golang.org/pkg/os/",
		},
	},
	"http://golang.org/pkg/fmt/": &mockResult{
		"Package fmt",
		[]string{
			"http://golang.org/",
			"http://golang.org/pkg/",
		},
	},
	"http://golang.org/pkg/os/": &mockResult{
		"Package os",
		[]string{
			"http://golang.org/",
			"http://golang.org/pkg/",
		},
	},
}

//////////////////////////////////////////////////////////////////////
// The code below supports the solution check.

// fetchSignal records each fetch for the timing check.
var fetchSignal chan bool

// fetchSignalInstance returns the shared signal channel.
func fetchSignalInstance() chan bool {
	if fetchSignal == nil {
		// Buffer the channel so sends do not block.
		fetchSignal = make(chan bool, 1000)
	}
	return fetchSignal
}
