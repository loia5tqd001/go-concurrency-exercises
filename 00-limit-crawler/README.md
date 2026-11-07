# Limit your crawler

The crawler asks for many pages at the same time. This puts too much
load on the web server. Change the code so it starts at most one page
request each second. Keep the crawler concurrent.

Right now every `go Crawl(...)` goroutine calls `fetcher.Fetch` as
soon as it starts. A group of URLs becomes a burst of requests:

```
today:  goroutine A ─▶ Fetch (t=0.00s)
        goroutine B ─▶ Fetch (t=0.00s)
        goroutine C ─▶ Fetch (t=0.01s)   ← webserver hammered
        goroutine D ─▶ Fetch (t=0.01s)

goal:   goroutine A ─▶ Fetch (t=0s) ─┐
        goroutine B ─▶ Fetch ········┼──▶ one shared gate,
        goroutine C ─▶ Fetch ········┤    at most 1 Fetch/sec,
        goroutine D ─▶ Fetch ········┘    however many goroutines race for it
```

The goroutines can still run together. Only the `Fetch` call waits for
its turn.

## Hint

You can solve this with three lines. The Go rate-limiting guide is
here:
https://go.dev/wiki/RateLimiting

## Test your solution

Use `go test` to verify if your solution is correct.

Correct solution:
```
PASS
ok      github.com/loia5tqd001/go-concurrency-exercises/00-limit-crawler  13.009s
```

Incorrect (or unmodified) solution:
```
    check_test.go:53: There exists a two crawls that were executed less than 1 second apart.
    check_test.go:54: Solution is incorrect.
--- FAIL: TestMain (0.00s)
FAIL
FAIL    github.com/loia5tqd001/go-concurrency-exercises/00-limit-crawler  0.17s
```
