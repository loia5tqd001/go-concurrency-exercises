# Limit your crawler

Given is a crawler (modified from the Go tour) that requests pages
excessively. However, we don't want to burden the webserver too
much. Your task is to change the code to limit the crawler to at most
one page per second, while maintaining concurrency (in other words,
Crawl() must be called concurrently)

Right now every `go Crawl(...)` goroutine calls `fetcher.Fetch` the
moment it runs, so a handful of URLs fan out into a burst of near
simultaneous requests:

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

Every goroutine still runs concurrently - only the moment it's allowed
to call `Fetch` gets serialized through one shared gate.

## Hint

This exercise can be solved in 3 lines only. If you can't do
it, have a look at this:
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
