# Bounded Pipeline with Backpressure

Given is a fast producer feeding a slow consumer. `RunPipeline` is
supposed to stream items from the producer to the consumer through a
*bounded* channel, so that if the consumer falls behind, the producer
is forced to slow down too - backpressure - instead of piling up
unboundedly-buffered, unconsumed work in memory. Right now it does the
opposite: it produces every item into an in-memory slice up front -
calling `produce(i)` for every one of them - before the consumer gets
to touch a single item, so the "fast producer, slow consumer" mismatch
never actually pushes back on the producer; it just silently buffers
the entire run in memory and runs everything sequentially.

`RunPipeline` itself doesn't know what an item is or what "slow"
means - both are entirely up to the caller. `produce(i)` generates
item `i` and returns it; `consume(item)` is handed that value and does
whatever expensive work it wants with it. In `main()` below (and in
this exercise's tests), that expensive work is `SlowConsume` (see
`mockslowconsumer.go`), which simulates a slow downstream sink (e.g.
writing to a remote store) by sleeping for 50ms per item - but
`RunPipeline` has no idea that's happening; it's just plumbing that
moves values of some type `T` from `produce` to `consume`.

Your task is to rewrite `RunPipeline` so production and consumption
run concurrently, connected by a channel with a small, fixed buffer
(e.g. size 2) instead of collecting everything into a slice up front:
start a goroutine that produces items and sends them on the channel,
closing the channel once it's done, while the consumer ranges over the
channel calling `consume` for each item it receives. Once the buffer
(plus the one item the consumer may be actively processing) is full,
the producer's next send must block until the consumer drains an item
- i.e. real backpressure. The function signature must stay the same:

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
