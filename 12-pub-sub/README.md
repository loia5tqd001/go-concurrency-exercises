# Pub-Sub: In-Memory Event Bus

`EventBus` lets many subscribers receive published events. Many
goroutines may call `Subscribe`, `Unsubscribe`, and `Publish` at the
same time.

The current implementation is broken in two ways:

1. There is no way to unsubscribe. After `Subscribe`, the subscriber
   stays in the bus forever. If it stops reading, the bus keeps its
   channel forever.

2. `Publish` sends to each subscriber one at a time. The send can
   block. One slow or stopped subscriber can stop `Publish` and block
   every other subscriber too.

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

Your task is to fix `EventBus`:

1. `Subscribe` returns a channel. The caller can pass that channel to
   the new method `Unsubscribe(ch)`. After `Unsubscribe` returns, the
   bus must not send new events or keep a reference to the channel.
   Events already buffered can still be read. All three methods must
   be safe to call at the same time.

2. `Publish` must not block because one subscriber is slow or stopped.
   Give each channel a buffer of 8 events. If the buffer is full, use
   a non-blocking send. Drop the event only for that subscriber.
   Keep serving every other subscriber.

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
