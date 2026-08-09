# Bounded Pipeline with Backpressure — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `18-bounded-pipeline-backpressure/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`RunPipeline[T any](itemCount, produce, consume)` is supposed to stream `itemCount` items from a fast producer to a slow consumer through a *bounded* channel, so that once the consumer falls behind, the producer is forced to slow down too instead of piling up unconsumed work in memory. `RunPipeline` itself doesn't know what an item is or what "slow" means — `produce(i)` generates item `i` and returns it as a `T`; `consume(item)` is handed that `T` and does whatever expensive work it wants with it. In this exercise that expensive work is `SlowConsume` (which sleeps 50ms per item — see `mockslowconsumer.go`), but `RunPipeline` never calls it directly; `consume` does. `produce(i)` must fire the instant item `i` is generated and `consume` the instant the item it returned is handed off, each exactly once; the callbacks may run on different goroutines and do their own locking, so `RunPipeline` doesn't need to synchronize around them.

`check_test.go` enforces this with two tests:

- `TestRunPipelineProcessesAllItems` — every index in `[0, itemCount)` is produced and consumed exactly once. This one is timing-agnostic and passes against both the naive and the fixed version.
- `TestRunPipelineAppliesBackpressure` — runs under `synctest.Test` (a fake, deterministic clock that jumps forward once every goroutine in the bubble is durably blocked) and tracks, at the moment each `produce(i)` fires, how many items have already been fully consumed. The gap `i - consumedSoFar` measures how far ahead of the consumer the producer was allowed to race. `consume` is where `SlowConsume` actually gets called in this test — `RunPipeline` has no idea it's happening. The test requires `maxGap <= 5` for `itemCount = 20`.

## Why the naive version is wrong

```go
items := make([]T, 0, itemCount) // unbounded: buffers the whole run
for i := 0; i < itemCount; i++ {
    items = append(items, produce(i))
}
for _, item := range items {
    consume(item)
}
```

Every one of the 20 `produce` calls completes and gets appended before `consume` is called even once — the producer can finish emitting the entire run before the consumer, which pays a real 50ms per item, has even started on item 0. Verified directly against this test suite: the naive version produces a `maxGap` of 19 (item 19 is produced while 0 items have been consumed), which blows the `<= 5` assertion:

```
--- FAIL: TestRunPipelineAppliesBackpressure (0.00s)
    check_test.go:109: max gap between how far production got ahead of consumption = 19, want <= 5 ...
FAIL
```

This isn't just a "the producer is briefly ahead" nuance — it's a memory bug that scales with input. Buffering the whole run into a slice means worst-case buffered-but-unconsumed work grows linearly with however many items you throw at it, which defeats the entire point of streaming through a pipeline instead of materializing the whole run up front.

## Approach: small, fixed-size buffered channel

Replace the slice with a channel sized to a small constant (2 in the reference solution). Once that many items (plus the one item the consumer may be actively processing) are in flight, the producer's next `ch <- produce(i)` blocks until the consumer drains one — that's the backpressure, and it holds regardless of `itemCount`.

```go
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

**Verified**: `go test -race -count=3 ./...` passes both tests; measured wall time ~4.9–5.0s for the full 20-item run, consistent with the consumer's fixed 50ms/item cost dominating.

Note what moved compared to a version where `RunPipeline` calls `SlowConsume` directly: `consume` — supplied entirely by the caller — is what decides an item is "slow" to handle at all. `RunPipeline` doesn't import or reference `SlowConsume`; it's pure channel plumbing over a type parameter `T`, reusable for any producer/consumer pair, not just this exercise's mock sink.

## Tuning the buffer size: throughput vs. memory vs. jitter tolerance

This is a genuine parameter to reason about, but it's worth being precise about what it does and doesn't buy you, rather than reaching for the stock "bigger buffer = more throughput" line — that line is wrong for *this* pipeline.

**It doesn't change steady-state throughput here.** The consumer is a fixed 50ms/item and is the only bottleneck; the producer in this exercise does no real work of its own. So the total time to process `itemCount` items is `itemCount × 50ms` no matter what the buffer size is — verified directly: an unbuffered channel (`boundedBufferSize = 0`) and the size-2 default both completed the 20-item run in ~4.9s under `-race`. A buffer in front of a consumer that's uniformly slower than the producer doesn't make the consumer any faster; it just changes how much unconsumed work is allowed to queue up while waiting for the consumer.

**Where a buffer *does* help throughput** is when the producer is bursty or per-item production cost varies — e.g. it occasionally stalls (a network call, a lock, GC pause) but is otherwise fast. A buffer lets the consumer keep draining previously-produced items during that stall instead of going idle waiting on the next `ch <- produce(i)`. With a perfectly steady producer like this exercise's, there's no stall to absorb, so the buffer's only visible effect is the gap size, not the runtime.

**What the buffer size actually trades:**

- **Memory / staleness vs. jitter tolerance.** A larger buffer tolerates more producer burstiness before the producer has to block, at the cost of allowing more unconsumed (and therefore "stale" — representing older, not-yet-acted-on state) items to sit in memory at once.
- **The gap bound scales directly with buffer size**, and independent of `itemCount` — which is exactly the property the naive slice-buffered version violates. Measured directly against `TestRunPipelineAppliesBackpressure` (`itemCount = 20`, assertion `maxGap <= 5`):

  | `boundedBufferSize` | max gap observed | test result |
  |---|---|---|
  | 0 (unbuffered) | 1 | PASS |
  | 2 (reference solution) | 3 | PASS |
  | 3 | 4 | PASS |
  | 4 | 5 | PASS (right at the edge) |
  | 5 | 6 | **FAIL** |
  | 6 | 7 | **FAIL** |

  The pattern is `maxGap == boundedBufferSize + 1` (buffer slots plus the one item the consumer is actively holding), and it's exactly linear — confirming the gap bound depends only on the buffer size, never on `itemCount`, unlike the naive version's unbounded slice.
- **Unbuffered (`boundedBufferSize = 0`) is a valid, more extreme point on the same knob**, not a structurally different design — it's still "a small, fixed-size channel between producer and consumer," just at the size-0 end. It gives the tightest possible bound on how far the producer can get ahead (at most one item is ever "in flight" beyond what the consumer is processing), at the cost of zero tolerance for any producer jitter: every single send synchronizes directly with a receive.

In short: pick the buffer size based on how much producer burstiness you need to absorb and how much staleness/memory you can tolerate, not based on an assumption that a bigger buffer makes the pipeline faster — here it doesn't, because the consumer is the bottleneck either way.

## Why `RunPipeline` is generic, and `consume` (not `RunPipeline`) owns `SlowConsume`

An earlier version of this exercise hardcoded `RunPipeline(itemCount int, produced func(i int), consumed func(i int))`, with `RunPipeline` itself calling `SlowConsume` between the two callbacks. That version worked, but it baked two unrelated things into one function: "stream items through a bounded channel" (genuinely reusable plumbing) and "the item type is `int`, and the slow operation is `SlowConsume`" (details specific to this mock). Making `RunPipeline` generic over `T`, and moving `SlowConsume` into the caller-supplied `consume`, separates those:

- `RunPipeline[T any]` is now a bounded-channel pipeline runner you could hand any `produce`/`consume` pair — a batch job writing rows to a database, an image resizer, whatever `T` and whatever expensive-per-item operation, without touching `RunPipeline` itself.
- The contract "`consume` fires exactly when the slow work finishes" is no longer a prose promise `RunPipeline` has to honor correctly — it's structurally guaranteed, because `consume` *is* the thing that does the slow work.

## Key takeaways

- Buffering the whole run into a slice up front isn't just "not bounded enough" — it's a bug whose worst-case memory footprint scales linearly with the input size, which is precisely what a bounded pipeline exists to avoid.
- The fix is not "add synchronization" (there's no race here — the naive version's tests even pass `TestRunPipelineProcessesAllItems`); it's sizing the channel deliberately, since Go channel buffer size *is* the backpressure control.
- Making the pipeline generic over `T` and letting `consume` own the slow operation keeps `RunPipeline` reusable plumbing instead of coupling it to one mock sink and one concrete type.
- `synctest.Test`'s fake clock makes `TestRunPipelineAppliesBackpressure` deterministic — it fast-forwards once every goroutine is durably blocked (e.g. asleep inside `SlowConsume`), so the gap measurement doesn't flake based on machine load.
- Buffer size is a real tuning knob, but only for absorbing producer burstiness/jitter and controlling memory/staleness — not for raw throughput when the consumer is a uniform bottleneck, which it is in this exercise. Don't over-claim what a bigger buffer gets you.
- If you need genuinely minimal producer lead, an unbuffered channel (buffer size 0) is a legitimate endpoint of the same "small, bounded channel" idea, not a separate architecture.
