# Pub-Sub: In-Memory Event Bus

Given is an `EventBus` that is supposed to let any number of
independent subscribers listen for events published to it, from any
number of goroutines calling `Subscribe`, `Unsubscribe`, and `Publish`
at the same time.

The current implementation is broken in two ways:

1. There is no way to unsubscribe. Once a caller calls `Subscribe`, it
   listens forever - there's no way to say "I'm done, stop sending to
   me and forget about my channel." A caller that goes away without
   draining its channel leaks it inside the bus forever.

2. `Publish` sends to every subscriber's channel one at a time with a
   blocking, unbuffered send. If even one subscriber is slow or has
   stopped reading, that single blocking send freezes the whole
   `Publish` call - which freezes delivery to every other subscriber
   too, and every future call to `Publish`, for as long as the
   stalled subscriber never reads.

```
today (scaffold): Publish holds b.mu, one blocking send per subscriber

  caller ──▶ Publish ──[ b.mu held ]──┬──▶ subA chan Event (cap 0)
                                      └──▶ subB chan Event (cap 0)

  Unsubscribe(ch) does nothing, so ch stays in the set forever.
  subA stops reading ──▶ ch <- e never returns ──▶ b.mu never released
                     ──▶ Subscribe and Publish block behind the same lock

goal (fix): one buffered channel per subscriber (cap 8), no send ever waits

  Subscribe() ──▶ add ch (cap 8) to the set, return it receive-only
  Unsubscribe(ch) ──▶ delete ch from the set ──▶ no sends, no reference

  caller ──▶ Publish ──[ b.mu ]──▶ non-blocking send ──┬──▶ subA [cap 8]
                                                       └──▶ subB [cap 8]

  one reader goroutine per subscriber; a full buffer drops that event for
  that subscriber only, and Publish moves on to the next one
```

Your task is to fix `EventBus` so that:

1. `Subscribe` returns a channel that a caller can stop listening to
   by calling the new method `Unsubscribe(ch)` with that same channel.
   After `Unsubscribe` returns, the bus must no longer send to that
   channel or keep a reference to it, so it can't leak and won't
   receive anything published afterward. `Subscribe`, `Unsubscribe`,
   and `Publish` must all be safe to call concurrently.

2. `Publish` must never block indefinitely because one subscriber is
   slow or stalled. Give each subscriber's channel a reasonable buffer
   (e.g. 8 events) and, when that buffer is full, drop the event for
   that subscriber only - via a non-blocking send - instead of
   blocking `Publish` or affecting delivery to any other subscriber.

The signatures below must stay exactly as they are:

```go
func NewEventBus() *EventBus
func (b *EventBus) Subscribe() <-chan Event
func (b *EventBus) Unsubscribe(ch <-chan Event)
func (b *EventBus) Publish(e Event)
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
