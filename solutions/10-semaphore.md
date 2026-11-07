# Semaphore: Bounding Parallelism Against a Rate-Limited API — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `10-semaphore/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`FetchAll` should fetch every request in `reqs` from `api`. It uses
`FlakyAPI.Call` in `mockapi.go`. Keep a small fixed number of calls in
flight. `FlakyAPI` does not queue extra calls. If more than
`maxConcurrent` run at once, extra calls fail with
`ErrTooManyConcurrentRequests`.

The naive version fires off one goroutine per request with no limit
at all:

```go
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
```

Your task is to build a counting semaphore with a buffered
`chan struct{}`. Do not use `golang.org/x/sync/semaphore` or another
package.
Use the semaphore to limit `api.Call`. Keep `FetchAll` concurrent. Do not
run every call one at a time. Keep this signature:
`func FetchAll(api *FlakyAPI, reqs []string) []string`.

## Why the naive version is wrong

Every request gets a goroutine. Each calls `api.Call` at once. Nothing
limits how many calls run. The API uses `NewFlakyAPI(3)`, so it rejects
more than 3 calls. With 12 requests, the code often exceeds that limit:

```
--- FAIL: TestFetchAllRespectsSemaphoreLimit (0.10s)
    check_test.go:77: API high-water mark = 4, want <= 2; FetchAll is not
        bounding its own concurrency strictly below the API's limit of 3
    check_test.go:84: result for "request-0" = "ERROR: too many concurrent
        requests"; a properly bounded FetchAll should never trip the API's
        own rejection logic
    check_test.go:84: result for "request-1" = "ERROR: too many concurrent
        requests"; ...
FAIL
```

In that run, 9 of 12 requests failed. The high-water mark was 4. The
worst case can be about 12, since all goroutines are ready. The real
number depends on the scheduler. It changes between runs. The code has
no cap, so it can hit the API limit. Add a cap inside `FetchAll`.

## Approach 1: A hand-rolled counting semaphore (buffered channel), one goroutine per request

```go {7,14,15}
const maxInFlight = 2

func FetchAll(api *FlakyAPI, reqs []string) []string {
	results := make([]string, len(reqs))
	var wg sync.WaitGroup

	sem := make(chan struct{}, maxInFlight)

	for i, r := range reqs {
		wg.Add(1)
		go func(i int, r string) {
			defer wg.Done()

			sem <- struct{}{}
			defer func() { <-sem }()

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
```

This keeps one goroutine per request and uses `sync.WaitGroup`, also
called `WaitGroup`. It adds one semaphore.
`sem := make(chan struct{}, maxInFlight)` is a buffered channel with
`maxInFlight` slots.

`sem <- struct{}{}` acquires a slot. It waits when the channel is full.
`<-sem` releases the slot. Wrap release in `defer`, so a panic still
frees it. At most `maxInFlight` goroutines can hold a slot.

`wg` tracks finished goroutines. `sem` tracks active calls. All
`len(reqs)` goroutines still start. The semaphore limits only the calls.

`maxInFlight = 2` is not a style choice. `mockapi.go` rejects when
`current > maxConcurrent`, so `NewFlakyAPI(3)` allows 3 calls.
`TestFetchAllRespectsSemaphoreLimit` requires
`wantMaxHighWaterMark = 2`.

`TestFetchAllStillConcurrent` also matters. It uses 10 requests at
`CallLatency`, 100ms each, in `check_test.go`. It uses `synctest` on a
fake clock. It requires under 600ms.

The time is about `ceil(10 / maxInFlight) * 100ms`. The value
`maxInFlight = 1` takes 1000ms and fails. A value of 2 takes 500ms and
passes. Both rules allow only 2.

## Approach 2: Fixed-size worker pool reading from a jobs channel (alternative)

This approach does not build a semaphore. It does not follow the
exercise's exact instruction to use a buffered channel of `struct{}`. It
shows another way to limit calls: start only `maxInFlight` workers. Both
designs pass with `maxInFlight = 2`. Use Approach 1 for the exercise.

```go
const maxInFlight = 2

type fetchJob struct {
	index int
	req   string
}

func FetchAll(api *FlakyAPI, reqs []string) []string {
	results := make([]string, len(reqs))

	jobs := make(chan fetchJob)

	var wg sync.WaitGroup
	wg.Add(maxInFlight)
	for w := 0; w < maxInFlight; w++ {
		go func() {
			defer wg.Done()
			for j := range jobs {
				res, err := api.Call(j.req)
				if err != nil {
					results[j.index] = "ERROR: " + err.Error()
					continue
				}
				results[j.index] = res
			}
		}()
	}

	go func() {
		for i, r := range reqs {
			jobs <- fetchJob{index: i, req: r}
		}
		close(jobs)
	}()

	wg.Wait()

	return results
}
```

This is a different design. It starts `maxInFlight` workers. They read
from an unbuffered `jobs` channel. A feeder sends every request and
closes the channel. Each worker ends its `for j := range jobs` loop.
`wg.Wait()` waits for the fixed workers and every result.

Both approaches pass with `maxInFlight = 2`. Both write `results[i]`
without a race. Each index has one writer. Approach 1 starts one
goroutine per request and uses a semaphore. Approach 2 uses a fixed
worker pool.

## Key takeaways

- A buffered `chan struct{}` is a counting semaphore. Send to acquire.
  Receive to release.
- Approach 1 caps active calls. Approach 2 caps worker count. Both are
  correct. One uses a counter; the other uses a fixed pool.
- Put `defer func() { <-sem }()` right after acquiring. This mirrors
  `defer mu.Unlock()` and protects early returns and panics.
- Size 2 is the only value that passes both the API limit and speed test.
  Read both tests together.
- Running all requests one at a time defeats the semaphore.
  `TestFetchAllStillConcurrent` catches that.
