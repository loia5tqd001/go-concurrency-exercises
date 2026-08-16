# Bounded Pipeline with Backpressure

`RunPipeline` is supposed to stream items from a fast producer to a
slow consumer through a *bounded* channel, so a consumer that falls
behind forces the producer to slow down too - backpressure - instead
of piling up unconsumed work in memory. Right now it does the
opposite:

```
Today: producer races ahead, buffers the whole run in memory
  produce(0) produce(1) ... produce(19)
       │           │              │
       ▼           ▼              ▼
  []T{ all 20 items sitting in memory, consume(0) hasn't run yet }
       │
       ▼
  consume(0) consume(1) ... consume(19)      (only now, one at a time)
```

Every `produce(i)` call completes and lands in the slice before
`consume` runs even once - so "fast producer, slow consumer" never
actually meets. Nothing pushes back on the producer, and the memory
held for unconsumed work grows linearly with `itemCount`.

`RunPipeline` doesn't know what an item is or what "slow" means - both
are entirely up to the caller. `produce(i)` generates item `i` and
returns it; `consume(item)` is handed that value and does whatever
expensive work it wants with it. In `main()` (and this exercise's
tests) that's `SlowConsume` (see `mockslowconsumer.go`), sleeping 50ms
per item to stand in for a slow downstream sink - but `RunPipeline`
never calls `SlowConsume` itself; it's pure plumbing over a type
parameter `T`.

Your task is to rewrite `RunPipeline` so production and consumption
run concurrently, connected by a channel with a small, fixed buffer
(e.g. size 2) instead of a slice:

```
Goal: a bounded channel makes the producer wait on the consumer
  produce(i) ──▶ ch (small, fixed cap) ──▶ consume(item)
   goroutine         buffered channel          range loop

  Once cap(ch) items are buffered AND the consumer is mid-item,
  the next  ch <- produce(i)  blocks until consume() drains one.
```

Start a goroutine that produces items and sends them on the channel,
closing the channel once it's done, while the consumer ranges over the
channel calling `consume` for each item it receives. The function
signature must stay the same:

```go
func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T))
```

`produce` and `consume` must each be called exactly once per item
(`produce(i)` right when item `i` is generated, `consume` right when
the item `produce` returned is handed off), and may be called from
different goroutines - the callbacks the tests pass in do their own
synchronization, so `RunPipeline` doesn't need to worry about that
itself.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
