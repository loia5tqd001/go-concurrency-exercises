# Pipeline: Multi-Stage Number Processing

The pipeline has three stages. `generator` makes numbers. `square`
squares them. `keepEven` keeps only even results.

Right now each stage finishes before the next one starts. The stages
do not overlap. `done` is ignored. The caller must wait for every item
even if it only needs one.

```
TODAY - batch per stage: every stage finishes before the next starts

  generator                square                    keepEven
  20 nums  ───all 20───▶   20 x work  ───all 20───▶   20 x work  ──▶ evens
  returns a slice          squares every item        filters every item
  (no work, never blocks)  (200ms for 20 items)      (200ms for 20 items)

  400ms in total, and done is never read

GOAL - 3 goroutines, unbuffered channels, one item at a time

  generator ──▶ square ──▶ keepEven ──▶ Pipeline
  1 goroutine   1 goroutine   1 goroutine   drains the channel
  emits nums    squares       drops odds    into a slice

  item 2 is generated while item 1 is squared: ~200ms for 20 items
  closing done unblocks each stage on its next send or receive
```

Make `generator`, `square`, and `keepEven` work on channels. Run each
stage in its own goroutine. A downstream stage should start before the
upstream stage ends.

Every stage must watch `done`. When `done` closes, stop it. Close each
output when its input ends. Use these signatures:

```go
func generator(done <-chan struct{}, nums ...int) <-chan int
func square(done <-chan struct{}, in <-chan int) <-chan int
func keepEven(done <-chan struct{}, in <-chan int) <-chan int
```

`Pipeline` connects the stages and collects the results. Keep its
signature:

```go
func Pipeline(done <-chan struct{}, nums ...int) []int
```

## Test your solution

Pass these tests:

```
go test
go test --race
```
