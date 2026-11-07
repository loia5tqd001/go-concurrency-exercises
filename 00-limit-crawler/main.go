//////////////////////////////////////////////////////////////////////
//
// Limit the crawler to one page per second.
// Keep the concurrent Crawl calls.
//
// Hint: three lines can do this.
//

package main

import (
	"fmt"
	"sync"
)

// Crawl fetches pages with fetcher from mockfetcher.go.
// It stops when depth reaches zero.
func Crawl(url string, depth int, wg *sync.WaitGroup) {
	defer wg.Done()

	if depth <= 0 {
		return
	}

	body, urls, err := fetcher.Fetch(url)
	if err != nil {
		fmt.Println(err)
		return
	}

	fmt.Printf("found: %s %q\n", url, body)

	wg.Add(len(urls))
	for _, u := range urls {
		// Keep the go keyword. Crawl must run concurrently.
		go Crawl(u, depth-1, wg)
	}
}

func main() {
	var wg sync.WaitGroup

	wg.Add(1)
	Crawl("http://golang.org/", 4, &wg)
	wg.Wait()
}
