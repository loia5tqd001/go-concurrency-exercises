# Pipeline: Multi-Stage Number Processing

Given is a numeric processing pipeline with three conceptual stages:
`generator`, which produces a sequence of numbers, `square`, which
squares each number, and `keepEven`, which keeps only the even
results. These are supposed to be independent pipeline stages, each
running concurrently and connected by channels, but the naive
`Pipeline` materializes the entire input as a slice and runs each
stage to completion, one at a time, before starting the next. Nothing
overlaps - `square` doesn't start on item 1 until `generator` has
produced every item, and `keepEven` doesn't start until `square` has
finished squaring every item - and there is no way to stop early: even
a caller that only wants the first result still pays for every item to
be pushed through every stage.

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

Your task is to turn `generator`, `square`, and `keepEven` into true
pipeline stages that operate on channels instead of slices, each
running in its own goroutine, so that a downstream stage can start
working on an item while an upstream stage is still producing the
next one. Every stage must also respect the `done` channel: once
`done` is closed, every stage still running must stop promptly instead
of blocking forever on a send nobody will ever receive, and every
stage must close its output channel once its input is exhausted so
that downstream stages (and the caller) know there's nothing more
coming. The new stage signatures must be:

```go
func generator(done <-chan struct{}, nums ...int) <-chan int
func square(done <-chan struct{}, in <-chan int) <-chan int
func keepEven(done <-chan struct{}, in <-chan int) <-chan int
```

`Pipeline` composes the three stages (`generator` -> `square` ->
`keepEven`) and drains the final stage's channel into a slice to
return. Its own signature must stay the same, since it's the one thing
callers/tests depend on:

```go
func Pipeline(done <-chan struct{}, nums ...int) []int
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
