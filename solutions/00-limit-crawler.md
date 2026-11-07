# Limit Your Crawler — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `00-limit-crawler/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`Crawl()` fetches pages. It starts a new goroutine for every link it finds.
This lets `fetcher.Fetch()` run as fast as the scheduler allows.

Your task is to allow at most one `Fetch()` call per second.
This limit applies to the whole program.
Keep the `go Crawl(...)` line so calls still start in their own goroutine.

The hidden test is in `check_test.go`. It hooks `fetchSignalInstance()`
from `mockfetcher.go`. The hook fires on every `Fetch` call. The test
fails if two fetches start less than about 0.95s apart.

## Why the naive version is wrong

The starting code has no shared limit. Each goroutine calls `fetcher.Fetch`
as soon as it runs. With 4 URLs across several depth levels, most fetches
run within milliseconds. A test run of the starting stub fails in under
one second:

```
    check_test.go:53: There exists a two crawls that were executed less than 1 second apart.
    check_test.go:54: Solution is incorrect.
--- FAIL: TestMain (0.00s)
FAIL
```

Concurrency is not the bug. Keep `go Crawl(...)`. The code needs one
shared gate. Every goroutine must pass through it before `Fetch`.

## Approach 1: `time.Tick` gate (the "3 lines" hint)

The three highlighted lines are the full change. The rest is the starting
code.

```go {6,12,23}
package main

import (
	"fmt"
	"sync"
	"time"
)

// throttle ticks once per second; every Fetch must wait for a tick
// before proceeding, so no two fetches can start less than 1s apart,
// no matter how many goroutines are racing to call Crawl concurrently.
var throttle = time.Tick(time.Second)

// Crawl uses `fetcher` from the `mockfetcher.go` file to imitate a
// real crawler. It crawls until the maximum depth has reached.
func Crawl(url string, depth int, wg *sync.WaitGroup) {
	defer wg.Done()

	if depth <= 0 {
		return
	}

	<-throttle
	body, urls, err := fetcher.Fetch(url)
	if err != nil {
		fmt.Println(err)
		return
	}

	fmt.Printf("found: %s %q\n", url, body)

	wg.Add(len(urls))
	for _, u := range urls {
		// Do not remove the `go` keyword, as Crawl() must be
		// called concurrently
		go Crawl(u, depth-1, wg)
	}
}

func main() {
	var wg sync.WaitGroup

	wg.Add(1)
	Crawl("http://golang.org/", 4, &wg)
	wg.Wait()
}
```

**How it works:** `time.Tick(time.Second)` returns a channel. It sends one
value every second. The channel is a package variable, so every
`go Crawl(...)` goroutine uses the same channel. `main` and the other
goroutines all share it.

Only one goroutine can receive each value. This limits `fetcher.Fetch` to
one call per second. The other goroutines wait at `<-throttle`. They still
run at the same time, so `Crawl()` still starts concurrently.

Verified in a scratch copy. `go test -race -count=5 ./...` passed all
five runs (`ok  	limitcrawler	66.937s`). That is about 13.4s per run. It
matches the README's expected `13.009s` range for 4 URLs and depth 4.

**Tradeoffs:** `time.Tick` creates a ticker that cannot stop. This is fine
for this short program. A long-running service should use `time.NewTicker`
and call `Stop()`. Keep the ticker shared so every goroutine uses the same
one. Both versions need one shared channel and one receive per fetch.

## Approach 2: Mutex-guarded "last fetch" timestamp + `time.Sleep`

```go {17,18,20}
package main

import (
	"fmt"
	"sync"
	"time"
)

var (
	rateMu    sync.Mutex
	lastFetch time.Time
)

// rateLimit blocks the caller until at least one second has elapsed
// since the previous call returned, across all goroutines.
func rateLimit() {
	rateMu.Lock()
	defer rateMu.Unlock()
	if wait := time.Second - time.Since(lastFetch); wait > 0 {
		time.Sleep(wait)
	}
	lastFetch = time.Now()
}

// Crawl uses `fetcher` from the `mockfetcher.go` file to imitate a
// real crawler. It crawls until the maximum depth has reached.
func Crawl(url string, depth int, wg *sync.WaitGroup) {
	defer wg.Done()

	if depth <= 0 {
		return
	}

	rateLimit()
	body, urls, err := fetcher.Fetch(url)
	if err != nil {
		fmt.Println(err)
		return
	}

	fmt.Printf("found: %s %q\n", url, body)

	wg.Add(len(urls))
	for _, u := range urls {
		// Do not remove the `go` keyword, as Crawl() must be
		// called concurrently
		go Crawl(u, depth-1, wg)
	}
}

func main() {
	var wg sync.WaitGroup

	wg.Add(1)
	Crawl("http://golang.org/", 4, &wg)
	wg.Wait()
}
```

**How it works:** this version stores the last fetch time in a shared
variable. Each call computes how long to wait. `sync.Mutex` makes the
check, sleep, and update one protected step.

Without the lock, two goroutines can read the same `lastFetch`. Both can
wait too little and fetch in the same window. Holding the lock during
`time.Sleep` makes goroutines wait their turn.

**Tradeoffs:** this has more lines and more subtle code. A common bug is
unlocking before the sleep, which starts the race again. It can compute
the wait each time, so it can support changing rates. For a fixed rate,
Approach 1 is simpler and common Go style.

Verified in the same scratch setup: `go test -race -count=3 ./...` passed all 3 runs (`ok  	limitcrawler	39.801s`).

## Key takeaways

- To limit concurrent work, protect one shared gate. Do not remove
  concurrency. Keep `go Crawl(...)`.
- A shared `time.Tick` or `time.NewTicker` channel allows one fetch per
  interval. Only one goroutine can receive each tick.
- A mutex and timestamp can also enforce the limit. Use `sync.Mutex`,
  `time.Sleep`, and `time.Since` carefully. Keep both the check and update
  inside the lock.
- Both fixes pass the real hidden test. It uses `fetchSignalInstance()` in
  `mockfetcher.go` and runs from `check_test.go`.
