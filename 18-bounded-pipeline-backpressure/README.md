# Bounded Pipeline with Backpressure

`RunPipeline` should move items from a fast producer to a slow
consumer. It should use a bounded channel. If the consumer falls
behind, the producer must slow down. This is backpressure. Memory must
not fill with unconsumed work.

Today, it does the opposite:

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

Today, every `produce(i)` call finishes and stores its item before
`consume` runs. The fast producer and slow consumer never meet.
Nothing slows the producer. Memory grows with `itemCount`.

`RunPipeline` does not know what an item is or what slow means. The
caller defines both. `produce(i)` makes item `i` and returns it.
`consume(item)` does the expensive work. In `main()` and the tests,
`consume` uses `SlowConsume` (see `mockslowconsumer.go`). It sleeps
50ms per item. `RunPipeline` never calls `SlowConsume`. It only moves
values of type `T`.

Your task is to rewrite `RunPipeline`. Production and consumption
must run at the same time. Connect them with a small fixed buffer
(e.g. size 2) instead of a slice:

```
Goal: a bounded channel makes the producer wait on the consumer
  produce(i) ──▶ ch (small, fixed cap) ──▶ consume(item)
   goroutine        buffered channel         range loop

  Once cap(ch) items are buffered AND the consumer is mid-item,
  the next  ch <- produce(i)  blocks until consume() drains one.
```

Make the producer, consumer, and shutdown signal coordinate. Leave no
send blocked when `RunPipeline` returns. Do not drop work by accident.
The function signature must stay the same:

```go
func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T))
```

Call `produce` and `consume` exactly once per item. Call `produce(i)`
when item `i` is made. Call `consume` when the produced item is handed
off. These calls may run on different goroutines. The test callbacks
coordinate their own access, so `RunPipeline` does not need to.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
