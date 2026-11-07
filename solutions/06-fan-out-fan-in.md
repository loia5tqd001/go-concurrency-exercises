# Fan-Out, Fan-In: Concurrent Thumbnail Generation — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `06-fan-out-fan-in/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`GenerateThumbnails` receives image URLs. It calls `ProcessImage` for each
URL and builds a `Thumbnail`. `ProcessImage` takes `ProcessingLatency`,
which is 150ms. Each URL is independent.

The given implementation is a plain sequential loop:

```go
func GenerateThumbnails(urls []string) []Thumbnail {
	thumbnails := make([]Thumbnail, 0, len(urls))

	for _, url := range urls {
		thumbnails = append(thumbnails, ProcessImage(url))
	}

	return thumbnails
}
```

Your task is to run the work across several goroutines. Then collect the
results into one slice. Do not drop or repeat a URL. Do not create a data
race. Keep the signature
`func GenerateThumbnails(urls []string) []Thumbnail`.

## Why the naive version is wrong

The starting code is correct. It does not produce bad output. It passes
`TestGenerateThumbnailsCorrectness` and
`TestGenerateThumbnailsConcurrentCorrectness`. It never drops or repeats
a URL. One goroutine cannot race on the result slice.

It fails `TestGenerateThumbnailsConcurrency`. This test uses
`synctest.Test` and a fake clock. It requires the call to finish well
under 500ms. Ten URLs at 150ms each take 1.5s:

```
--- FAIL: TestGenerateThumbnailsConcurrency (0.00s)
    check_test.go:95: GenerateThumbnails took 1.5s (sequential would take 1.5s);
    want well under 500ms - looks like URLs are being processed one at a time
    instead of concurrently
```

The defect is speed, not correctness. The function does the right work.
It runs the work one item at a time. The independent calls should overlap.

## Approach 1: Fixed worker pool (jobs channel + results channel)

This is the common fan-out/fan-in shape. A small fixed set of workers
reads URLs from `jobs` and calls `ProcessImage`. Each worker sends a
`Thumbnail` to `results`. Another goroutine closes `results` after all
workers finish. The main goroutine ranges over `results`.

```go
func GenerateThumbnails(urls []string) []Thumbnail {
	const numWorkers = 8

	jobs := make(chan string)
	results := make(chan Thumbnail)

	var wg sync.WaitGroup
	wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go func() {
			defer wg.Done()
			for url := range jobs {
				results <- ProcessImage(url)
			}
		}()
	}

	go func() {
		for _, url := range urls {
			jobs <- url
		}
		close(jobs)
	}()

	go func() {
		wg.Wait()
		close(results)
	}()

	thumbnails := make([]Thumbnail, 0, len(urls))
	for th := range results {
		thumbnails = append(thumbnails, th)
	}

	return thumbnails
}
```

How it works:

- **Fan-out:** `numWorkers` goroutines range over `jobs`. Each URL goes
  to one worker. The worker uses `for url := range jobs`. A channel
  handoff is atomic, so no URL repeats or drops.
- A goroutine sends every URL to `jobs`, then closes it. This ends the
  worker loops.
- **Fan-in:** every worker sends to `results`. A channel protects these
  sends, so workers do not race.
- `sync.WaitGroup` tracks the workers. After `wg.Wait()`,
  `close(results)` is safe. The final collector uses `range results` and
  then stops.
- Only the collector changes `thumbnails`, so it needs no lock.

`numWorkers` limits `ProcessImage` calls. A low value can act almost
sequential. A high value adds overhead and may not improve speed. Use a
fixed pool for many URLs or a limited image service.

## Approach 2: Unbounded fan-out, one goroutine per URL

This design starts one goroutine per URL. It does not use a fixed pool.
Each goroutine calls `ProcessImage` once and sends to `results`. The same
collector gathers the results.

```go
func GenerateThumbnails(urls []string) []Thumbnail {
	results := make(chan Thumbnail)

	var wg sync.WaitGroup
	wg.Add(len(urls))
	for _, url := range urls {
		go func(url string) {
			defer wg.Done()
			results <- ProcessImage(url)
		}(url)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	thumbnails := make([]Thumbnail, 0, len(urls))
	for th := range results {
		thumbnails = append(thumbnails, th)
	}

	return thumbnails
}
```

This is still fan-out/fan-in. `results` still has one collector. The
fan-out now has one goroutine per URL. No `jobs` channel is needed. Each
goroutine gets its URL as an argument, so the loop variable does not
change its value.

Tradeoffs versus Approach 1:

- **Goroutine count grows with URLs.** It is unbounded. Ten or fifty URLs
  are fine. One hundred thousand URLs create one hundred thousand calls.
  The worker pool stays at `numWorkers`.
- **The code is simpler.** It has no jobs channel and no feeder goroutine.
- Both designs return results in completion order, not input order. They
  do not keep the order of `urls`. The tests index results by URL, so they
  do not care. To keep order, store the original index with each result.

Use one goroutine per URL for a small fixed batch. Use a worker pool when
the input can grow or you need a concurrency limit.

## Approach 2b: Same fan-out, fan-in via an indexed slice instead of a channel

This keeps one goroutine per URL. It changes the fan-in. Each goroutine
writes to its own index in a pre-sized slice. There is no `results`
channel or collector.

```go {2,7}
func GenerateThumbnails(urls []string) []Thumbnail {
	thumbnails := make([]Thumbnail, len(urls))

	var wg sync.WaitGroup
	for idx, url := range urls {
		wg.Go(func() {
			thumbnails[idx] = ProcessImage(url)
		})
	}
	wg.Wait()

	return thumbnails
}
```

This needs no lock or channel. `thumbnails` has `len(urls)` slots. Each
goroutine writes one unique `idx`. Go 1.22 and later give each loop pass
its own variables. Writes to different slice elements are not a data
race. `wg.Wait()` waits for every write.

The code uses `wg.Go(func() { ... })`, added in Go 1.24. It replaces
manual `wg.Add(1)` and `defer wg.Done()`. You cannot forget the `Done()`
call.

Tradeoffs versus Approach 2:

- **It keeps order.** Each result goes to its input position. Approaches
  1 and 2 return completion order.
- **It has fewer parts.** There is no `results` channel and no goroutine
  that closes it.
- **It needs the result count first.** You cannot use it for an unknown
  result count. The caller also gets no result until all goroutines end.

## Key takeaways

- The starting loop is correct but slow. `TestGenerateThumbnailsCorrectness`
  passes. `TestGenerateThumbnailsConcurrency` fails.
- A channel can collect results without a mutex. Workers send to
  `results`, and the consumer uses `range`. The channel protects the
  handoff.
- Use `sync.WaitGroup` and one goroutine to close the channel after
  `wg.Wait()`. A worker must not close it. It could close too early or
  twice.
- Approaches 1 and 2 return completion order. Keep the input order by
  storing each index with its result. Approach 2b writes by index.
- A fixed worker pool caps work. One goroutine per item is simpler. Pick
  based on input size and limits.
