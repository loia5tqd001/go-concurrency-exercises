# A bounded pipeline with backpressure

> **Spoiler warning.** This file has a full solution for `18-bounded-pipeline-backpressure/`. Try the exercise first. Come back if you get stuck.

## The problem

`RunPipeline[T any](itemCount, produce, consume)` moves items from a fast producer to a slow consumer. It uses a bounded channel. When the consumer falls behind, the producer must slow down. The pipeline must not pile up work in memory.

`RunPipeline` does not know what an item is. It also does not know what "slow" means.

`produce(i)` makes item `i` and returns it as a `T`. `consume(item)` receives that value and does the expensive work. Here the work is `SlowConsume`, which sleeps 50ms per item. See `mockslowconsumer.go`.

`RunPipeline` never calls `SlowConsume` directly. The `consume` callback does.

Each item must trigger `produce` once and `consume` once. The callbacks can run on different goroutines. They can do their own locking. `RunPipeline` does not need to lock around them.

`produce(i)` records the moment it makes item `i`. `consume(item)` records the moment it receives the item.

`check_test.go` enforces this with two tests:

- `TestRunPipelineProcessesAllItems` checks every index in `[0, itemCount)`. It must be produced once and consumed once. This test ignores timing, so the naive and fixed versions both pass.
- `TestRunPipelineAppliesBackpressure` uses `synctest.Test`. This fake clock moves forward when every goroutine in its bubble is blocked.
- The test records how many items are consumed when each `produce(i)` fires. The gap `i - consumedSoFar` shows how far the producer got ahead.
- The test calls `SlowConsume` from `consume`. `RunPipeline` does not know this.
- The test requires `maxGap <= 5` for `itemCount = 20`.

## Why the naive version is wrong

```go {1}
items := make([]T, 0, itemCount) // unbounded: buffers the whole run
for i := 0; i < itemCount; i++ {
    items = append(items, produce(i))
}
for _, item := range items {
    consume(item)
}
```

All 20 `produce` calls finish before the first `consume` call. The producer can finish the entire run first. The consumer pays 50ms per item and has not started item 0.

The naive version reports a `maxGap` of 19. Item 19 is produced before any item is consumed. This fails the `<= 5` check:

```
--- FAIL: TestRunPipelineAppliesBackpressure (0.00s)
    check_test.go:109: max gap between how far production got ahead of consumption = 19, want <= 5 ...
FAIL
```

This is not a small timing issue. It is a memory bug that grows with the input size. A slice holds every unconsumed item. Memory use grows with the item count. That defeats the purpose of a streaming pipeline.

## Approach: small, fixed-size buffered channel

Replace the slice with a channel of size 2. Once that buffer fills, the next `ch <- produce(i)` blocks. The producer waits until the consumer drains one item. This is backpressure. It works for any `itemCount`.

```go {10,20,25}
package main

import "fmt"

// boundedBufferSize is a small, fixed channel buffer between the
// producer and the consumer. Once this many items (plus the one item
// the consumer may be actively processing) are in flight, the
// producer's send blocks until the consumer drains one - that's the
// backpressure.
const boundedBufferSize = 2

// RunPipeline streams itemCount items (0..itemCount-1) from a fast
// producer to a slow consumer through a small, bounded channel. Once
// the buffer fills up, the producer's send blocks until the consumer
// drains an item, so a slow consumer naturally throttles a fast
// producer instead of letting it buffer the entire run in memory.
// RunPipeline itself never sees what T is or what consume does with
// it - both are entirely the caller's concern.
func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T)) {
	ch := make(chan T, boundedBufferSize)

	go func() {
		defer close(ch)
		for i := 0; i < itemCount; i++ {
			ch <- produce(i) // blocks once the buffer is full - backpressure
		}
	}()

	for item := range ch {
		consume(item)
	}
}

func main() {
	RunPipeline(20, func(i int) int {
		fmt.Println("produced", i)
		return i
	}, func(item int) {
		SlowConsume(item)
		fmt.Println("consumed", item)
	})
}
```

`go test -race -count=3 ./...` passes both tests. The full 20-item run takes about 4.9 to 5.0 seconds. This matches the consumer's fixed 50ms cost per item.

In an earlier version, `RunPipeline` called `SlowConsume` directly. Now the caller supplies `consume`, so the caller decides what is slow.

`RunPipeline` does not import or name `SlowConsume`. It only moves values of type `T` through a channel. You can reuse it with any producer and consumer pair.

## Tuning the buffer size: throughput vs. memory vs. jitter tolerance

Buffer size is a real choice. Be precise about what it changes. A bigger buffer does not always mean more throughput. That rule is false for this pipeline.

The buffer does not change steady throughput here. The consumer takes 50ms per item and is the only bottleneck. The producer does no real work.

Total time is `itemCount × 50ms` for every buffer size. I checked this. An unbuffered channel and the size-2 default both take about 4.9 seconds under `-race`.

A buffer cannot make a slower consumer faster. It only changes how much work can wait in memory.

A buffer helps when the producer is bursty. Production cost can also vary. A network call, lock, or GC pause can stop the producer for a while.

During that pause, the consumer can keep reading items already in the buffer. It does not sit idle waiting for the next `ch <- produce(i)`.

This exercise has a steady producer. There is no pause to absorb. The buffer only changes the gap, not the runtime.

The buffer size changes these tradeoffs:

- Memory and stale data versus jitter tolerance. A larger buffer lets the producer absorb longer bursts.
- The cost is more unconsumed items in memory. They can be older and less useful.
- The gap limit grows with buffer size and does not depend on `itemCount`. The naive slice version breaks this rule.
- I measured these values with `TestRunPipelineAppliesBackpressure`. It uses `itemCount = 20` and `maxGap <= 5`:

  | `boundedBufferSize` | max gap observed | test result |
  |---|---|---|
  | 0 (unbuffered) | 1 | PASS |
  | 2 (reference solution) | 3 | PASS |
  | 3 | 4 | PASS |
  | 4 | 5 | PASS (right at the edge) |
  | 5 | 6 | **FAIL** |
  | 6 | 7 | **FAIL** |

The pattern is `maxGap == boundedBufferSize + 1`. The extra item is the one the consumer holds. The gap depends only on buffer size, not `itemCount`.

An unbuffered channel is `boundedBufferSize = 0`. It is still the same design, just at size 0.

It gives the smallest gap. At most one item can be in flight beyond the item the consumer holds. It allows no producer jitter. Every send must meet a receive.

Pick a buffer size based on how much burst you must absorb. Also consider how much memory and stale work you can accept. Do not assume a bigger buffer makes this pipeline faster.

## Why `RunPipeline` is generic, and `consume` (not `RunPipeline`) owns `SlowConsume`

An earlier version used `RunPipeline(itemCount int, produced func(i int), consumed func(i int))`. `RunPipeline` called `SlowConsume` between the callbacks.

That version worked, but it joined two unrelated jobs. One job was streaming items through a bounded channel. The other was knowing that the item is an `int` and the slow step is `SlowConsume`.

The generic version separates those jobs:

- `RunPipeline[T any]` now accepts any `produce` and `consume` pair. You can reuse it for database rows, image resizing, or another job.
- The rule "`consume` fires when the slow work finishes" is now structural. `consume` is the slow work, so you do not rely on a prose promise.

## Key takeaways

- A slice that holds the full run has a memory cost that grows with input. A bounded pipeline avoids that.
- This is not a race bug. The naive version passes `TestRunPipelineProcessesAllItems`. The fix is to choose the channel size on purpose.
- In Go, the channel buffer size controls backpressure.
- Using `T` and letting `consume` own the slow work keeps `RunPipeline` reusable. It no longer depends on one mock or one type.
- The `synctest.Test` clock makes `TestRunPipelineAppliesBackpressure` stable. It moves forward when all goroutines are blocked, so machine load cannot change the gap.
- Buffer size absorbs producer bursts and controls memory and stale data. It does not raise raw throughput when the consumer is the bottleneck.
- An unbuffered channel gives the smallest producer lead. It is one end of the same design, not a separate design.
