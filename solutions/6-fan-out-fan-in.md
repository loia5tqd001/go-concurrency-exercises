# Fan-Out, Fan-In: Concurrent Thumbnail Generation — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `6-fan-out-fan-in/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`GenerateThumbnails` takes a list of image URLs and calls `ProcessImage`
on each one to build a `Thumbnail`. `ProcessImage` always takes a fixed
`ProcessingLatency` (150ms) to run, and it's completely independent
per URL — nothing about processing one image depends on any other.

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

The task is to fan the work out across multiple goroutines that call
`ProcessImage` concurrently, then fan the results back in into a
single slice — without dropping a result, without processing a URL
twice, and without a data race — all while keeping the signature
`func GenerateThumbnails(urls []string) []Thumbnail` unchanged.

## Why the naive version is wrong

Careful: "wrong" here doesn't mean "produces bad output." The
sequential loop is fully correct — it passes
`TestGenerateThumbnailsCorrectness` and
`TestGenerateThumbnailsConcurrentCorrectness` every time, because it
never drops a URL, never duplicates one, and (being single-threaded)
can't possibly race on the result slice.

What it fails is `TestGenerateThumbnailsConcurrency`, which uses
`synctest.Test` to run the whole call on a fake clock and asserts the
elapsed (fake) time stays well under 500ms. Ten URLs at 150ms each
sequentially costs exactly 1.5s — and that's exactly what the test
observes:

```
--- FAIL: TestGenerateThumbnailsConcurrency (0.00s)
    check_test.go:95: GenerateThumbnails took 1.5s (sequential would take 1.5s);
    want well under 500ms - looks like URLs are being processed one at a time
    instead of concurrently
```

So the defect is a *throughput* bug, not a correctness bug: the
function does the right work, just serially, when the whole point of
the exercise is that `ProcessImage` calls are independent and should
overlap.

## Approach 1: Fixed worker pool (jobs channel + results channel)

This is the classic fan-out/fan-in shape: a small, bounded number of
worker goroutines pull URLs off a shared `jobs` channel, call
`ProcessImage`, and push the resulting `Thumbnail` onto a shared
`results` channel. A separate goroutine closes `results` once all
workers are done, so the main goroutine can simply `range` over it
until every result has been collected.

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

Walking through the pieces:

- **Fan-out**: `numWorkers` goroutines all `range` over the same
  `jobs` channel. Each URL is handed to exactly one worker — that's
  what guarantees no URL is processed twice and none are dropped,
  since a channel send is a single, atomic handoff to whichever
  worker happens to receive it.
- A dedicated goroutine feeds `jobs` and closes it once every URL has
  been sent, which is what lets the `for url := range jobs` loops in
  the workers terminate.
- **Fan-in**: every worker writes to the *same* `results` channel.
  Because it's a channel (not a shared slice or map), concurrent
  writers don't race — the channel's internal synchronization
  serializes the sends.
- A `sync.WaitGroup` tracks worker completion; once `wg.Wait()`
  returns, it's safe to `close(results)`, which is what lets the
  final collector loop terminate instead of blocking forever.
- The collector loop is the only place that touches the `thumbnails`
  slice, so no locking is needed there either.

`numWorkers` bounds how many `ProcessImage` calls run at once. That
number is a knob: too low and you're back to serial-ish behavior for
large URL lists; too high and you get no benefit beyond the number of
URLs while spending more goroutines and scheduler overhead than
necessary. A fixed pool is the right call when there could be
thousands of URLs and you want to cap concurrent work (e.g. to avoid
hammering a downstream image service).

## Approach 2: Unbounded fan-out, one goroutine per URL

A genuinely different design: instead of a fixed pool of workers
pulling from a jobs queue, spawn one goroutine *per URL* directly.
Each goroutine calls `ProcessImage` once and sends its own result onto
a shared `results` channel; a collector fans those back in exactly as
before.

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

This is still fan-out/fan-in — there's still a shared `results`
channel and a single collector loop draining it — it's just that the
"fan-out" side has as many goroutines as there are URLs instead of a
capped pool reading off a jobs queue. No `jobs` channel is needed at
all, since each goroutine already knows which single URL it owns
(captured as a function argument, avoiding the classic loop-variable
capture bug).

Tradeoffs versus Approach 1:

- **Goroutine count is unbounded**, growing linearly with the number
  of URLs. Fine for 10 or 50 URLs; if this were called with 100,000
  URLs it would spin up 100,000 goroutines and (worse) 100,000
  concurrent `ProcessImage` calls, with no cap on how much downstream
  load that generates. The worker-pool version caps concurrency at
  `numWorkers` regardless of input size.
- **Simpler code**: no jobs channel, no feeder goroutine — one loop
  fewer to reason about.
- Both approaches return results in *completion* order, not input
  order — neither preserves the order of `urls`. The tests don't
  check ordering (they index results by URL), but it's worth knowing
  if you reuse this pattern somewhere that does care about order:
  you'd need to tag each result with its original index and sort (or
  write into a pre-sized slice by index) to recover it.

Reach for the unbounded version when the work list is naturally
small and bounded (a fixed batch, a handful of URLs from a single
request) and the downstream service has no meaningful concurrency
limit worth respecting. Reach for the worker-pool version whenever the
input size isn't bounded up front or you need a concurrency cap.

## Key takeaways

- The naive loop's bug here is throughput, not correctness — it never
  drops, duplicates, or corrupts a result. That's a different failure
  mode than the shared-state races in earlier exercises, and it's why
  `TestGenerateThumbnailsCorrectness` passes against it while
  `TestGenerateThumbnailsConcurrency` fails.
- Channels are the fan-in mechanism that avoids a mutex: every worker
  writes to the same `results` channel, and the channel's own
  synchronization is what prevents the data race, not a lock around a
  shared slice.
- `sync.WaitGroup` + a dedicated "close after Wait" goroutine is the
  standard way to know when to close a fan-in channel — closing it
  from any single worker directly would either close it too early (if
  another worker is still sending) or panic on a double-close.
- Both approaches return thumbnails in completion order, not input
  order. If order matters, track the original index alongside the
  result and reassemble afterward.
- Bounded (worker pool) vs. unbounded (goroutine-per-item) fan-out is
  a real design choice, not a stylistic one: it trades code simplicity
  against a concurrency cap that matters once the input size isn't
  small and fixed.
