# Pipeline: Multi-Stage Number Processing — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `08-pipeline/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`Pipeline` should run numbers through three stages. `generator` sends the
input. `square` squares each value. `keepEven` keeps only even results.
Each stage should have its own goroutine and use channels.

The starting code does not stream. Every stage uses a `[]int` and returns
another `[]int`:

```go
func generator(done <-chan struct{}, nums ...int) []int {
	return nums
}

func square(done <-chan struct{}, nums []int) []int {
	out := make([]int, len(nums))
	for i, n := range nums {
		SimulateWork()
		out[i] = n * n
	}
	return out
}

func keepEven(done <-chan struct{}, nums []int) []int {
	var out []int
	for _, n := range nums {
		SimulateWork()
		if n%2 == 0 {
			out = append(out, n)
		}
	}
	return out
}

func Pipeline(done <-chan struct{}, nums ...int) []int {
	return keepEven(done, square(done, generator(done, nums...)))
}
```

Turn each stage into a goroutine. It must read and write channels instead
of slices. These signatures must stay exact:

```go
func generator(done <-chan struct{}, nums ...int) <-chan int
func square(done <-chan struct{}, in <-chan int) <-chan int
func keepEven(done <-chan struct{}, in <-chan int) <-chan int
```

`Pipeline`'s signature must also stay the same:
`func Pipeline(done <-chan struct{}, nums ...int) []int`.

## Why the naive version is wrong

The starting code produces correct output. It passes
`TestPipelineCorrectness`, because `keepEven(square(generator(nums)))`
has the right result. It passes `TestPipelineConcurrentUse`, because each
call has its own slices.

It fails speed and shutdown:

```
--- FAIL: TestPipelineStagesOverlap (0.00s)
    check_test.go:79: Pipeline took 400ms to process 20 items; want well under 250ms - looks like generator, square, and keepEven are running one at a time over the whole batch instead of overlapping as a pipeline
--- FAIL: TestPipelineStopsEarly (0.00s)
    check_test.go:117: Pipeline took 2s to return after done was closed while processing 100 items; want well under 200ms - looks like the pipeline keeps working through the entire input instead of stopping once done fires
```

Each stage builds a full slice, which causes two problems:

1. **No overlap.** `generator` must finish every item before `square`
   starts. `square` must finish before `keepEven` starts. With 20 items
   and `WorkLatency` per stage, the cost is about
   `3 * 20 * WorkLatency`.
2. **No early exit.** `done` is a parameter, but no stage checks it.
   `generator`, `square`, and `keepEven` keep working after the caller
   stops waiting.

## Approach 1: Channel-based stages, each watching `done` on every operation

Each stage starts a goroutine. It creates an output channel and processes
one item at a time. `generator` uses `nums`; other stages read from `in`.
The stage closes `out` with `defer`.

Every blocking channel operation also waits on `<-done`. This applies to
reads from `in` and sends to `out`. A stage then cannot wait forever.

```go {12,38,41,71,74}
func generator(done <-chan struct{}, nums ...int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for _, n := range nums {
			SimulateWork()

			select {
			case out <- n:
			case <-done:
				return
			}
		}
	}()

	return out
}

func square(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for {
			select {
			case n, ok := <-in:
				if !ok {
					return
				}

				SimulateWork()

				select {
				case out <- n * n:
				case <-done:
					return
				}
			case <-done:
				return
			}
		}
	}()

	return out
}

func keepEven(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for {
			select {
			case n, ok := <-in:
				if !ok {
					return
				}

				SimulateWork()

				if n%2 != 0 {
					continue
				}

				select {
				case out <- n:
				case <-done:
					return
				}
			case <-done:
				return
			}
		}
	}()

	return out
}

func Pipeline(done <-chan struct{}, nums ...int) []int {
	numsCh := generator(done, nums...)
	squaresCh := square(done, numsCh)
	evensCh := keepEven(done, squaresCh)

	var out []int
	for n := range evensCh {
		out = append(out, n)
	}

	return out
}
```

How it works:

- **Stages overlap.** `generator` sends item 1 as soon as it is ready.
  `square` can start at once. The same relation holds with `keepEven`.
- `square` and `keepEven` use `select` while reading from `in` and while
  sending to `out`. Their read branches are `case n, ok := <-in` and
  `case <-done`. Their send branch is `case out <- ...`.
- A closed input gives `!ok`. `generator` only sends, so it checks
  `done` there. The final collector uses `range`.
- Each stage closes its `out` on every exit path. Downstream loops end.
  `Pipeline` can finish its final `for n := range evensCh` loop.
- The caller calls `close(done)` once. In `main`, use
  `defer close(done)`. Every stage watches the same channel. Each stage
  reacts without waiting for a neighbor.

## Approach 2: Draining upstream before exiting on `done`

This is another variant. It is not required by this exercise. When
`done` fires, `square` and `keepEven` first empty their input channels.

```go {19,23,54,58}
func square(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for {
			select {
			case n, ok := <-in:
				if !ok {
					return
				}

				SimulateWork()

				select {
				case out <- n * n:
				case <-done:
					drain(in)
					return
				}
			case <-done:
				drain(in)
				return
			}
		}
	}()

	return out
}

func keepEven(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)

	go func() {
		defer close(out)

		for {
			select {
			case n, ok := <-in:
				if !ok {
					return
				}

				SimulateWork()

				if n%2 != 0 {
					continue
				}

				select {
				case out <- n:
				case <-done:
					drain(in)
					return
				}
			case <-done:
				drain(in)
				return
			}
		}
	}()

	return out
}

// drain reads every remaining item from in until in is exhausted - a
// "don't leave the upstream sender blocked" cleanup pattern.
func drain(in <-chan int) {
	for range in {
		SimulateWork()
	}
}
```

`generator` and `Pipeline` do not change. `generator` has no `in`
channel. Its input is the `nums` slice.

The tradeoff:

- Approach 1 is smaller and reacts faster.
- It expects every upstream stage to watch the same `done`. That is true
  here.
- If a producer does not watch `done`, stopping a send can leave that
  producer blocked forever.
- Draining lets the producer finish.
- Draining also does `SimulateWork()` for every remaining item. A stage
  can run much longer when input is large.

Both approaches pass here. Every stage watches `done` on its sends. Use
Approach 1 when you trust all stages and want simple shutdown. Drain when
the producer may not watch `done`.

## Key takeaways

- The starting code is correct but slow. `TestPipelineCorrectness`
  passes. `TestPipelineStagesOverlap` and `TestPipelineStopsEarly` fail.
- A stage creates `out`, starts a goroutine, reads `in`, and writes
  `out`. Use `defer close()` on every exit path.
- Check `done` while reading and sending. Guarding one side can still
  block forever.
- One shared `done` lets each stage stop alone. This makes immediate exit
  safe here.
- Draining protects a producer that may not watch `done`. It can add
  delay and discarded work.
