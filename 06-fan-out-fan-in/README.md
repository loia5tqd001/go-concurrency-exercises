# Fan-Out, Fan-In: Concurrent Thumbnail Generation

`GenerateThumbnails` makes one thumbnail for each URL. It calls
`ProcessImage` for each one. That call is slow. It waits for a fixed
time before it returns. The current code handles URLs one by one. The
total time grows with the URL count.

```
today: 1 goroutine, 10 images × 150ms each = 1.5s

  img1  ──▶ ProcessImage ──▶ thumb1
  img2  ──▶ ProcessImage ──▶ thumb2
  ...
  img10 ──▶ ProcessImage ──▶ thumb10
  (each call waits for the previous one to return)

goal: 10 fan-out goroutines (one per URL), all at once, ~150ms for all 10

  img1  ──▶ ProcessImage ─┐
  img2  ──▶ ProcessImage ─┤
  ...                     ├──▶ fan-in ──▶ []Thumbnail × 10
  img10 ──▶ ProcessImage ─┘
```

Change `GenerateThumbnails` so the image work runs at the same time.
Collect every result into one slice. Return one result for each URL.
Do not drop, duplicate, or race on data.

One goroutine per URL is fine. A `sync.WaitGroup` can wait for all
results. You do not need a fixed worker pool here. Pool size is covered
later in
[10-semaphore](../10-semaphore) and [11-worker-pool](../11-worker-pool).

Keep the function signature:

```go
func GenerateThumbnails(urls []string) []Thumbnail
```

## Test your solution

Pass these tests:

```
go test
go test --race
```
