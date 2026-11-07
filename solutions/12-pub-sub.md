# Pub-Sub: In-Memory Event Bus — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `12-pub-sub/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`EventBus` lets many independent subscribers receive events.
`Subscribe`, `Unsubscribe`, and `Publish` must be safe to call at the
same time. Two things need fixing:

1. There is no way to unsubscribe. The bus keeps every channel forever.
2. `Publish` uses a blocking send to each subscriber. One slow subscriber
   can stop all delivery and every future `Publish` call.

The starting `main.go` does not compile against `check_test.go`. The
`Unsubscribe` method is missing. Writing it is part of the task.

## Why the naive version is wrong

The file comment names two bugs. A third problem makes them worse. The
blocking send runs while holding `b.mu`:

```go {6}
func (b *EventBus) Publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, ch := range b.subscribers {
		ch <- e // blocking send, inside the critical section
	}
}
```

A stalled reader stops `Publish`. It also holds `b.mu` forever.
`Subscribe` and `Unsubscribe` then block too. One stuck reader can stop
every public method.

Do not block inside a critical section. Keep the lock for shared state.
Make every send non-blocking. Then subscriber speed cannot control the
lock duration.

`Unsubscribe` takes `<-chan Event`. `Subscribe` creates and stores
`chan Event`, because it must send. Go cannot turn a receive-only channel
back into a two-way channel. You cannot index `map[chan Event]...`
directly with `<-chan Event`. Both designs compare channels with `==`
instead.

At higher scale, use `map[<-chan Event]chan Event` and
`subs[(<-chan Event)(ch)] = ch` for O(1) removal. This exercise does not
need it. A simple scan is fine.

`Unsubscribe` does not close `ch`. The bus only needs to forget the
channel. Another path may still send to it.

## Approach 1: buffered channels + non-blocking `Publish`, mutex-protected registry

The subscriber set is `map[chan Event]struct{}`. A plain `sync.Mutex`
protects it. Each channel has a buffer of 8. `Publish` uses
`select`/`default`, so a full buffer drops one event for one subscriber.
`Unsubscribe` takes the same lock and deletes the entry.

```go {38,68-69}
package main

import (
	"fmt"
	"sync"
	"time"
)

// Event is a single message flowing through the bus.
type Event struct {
	Topic string
	Data  string
}

const subscriberBuffer = 8

// EventBus lets any number of subscribers listen for published
// events, supports cleanly unsubscribing, and makes sure a slow or
// stalled subscriber can never cause Publish to block.
type EventBus struct {
	mu          sync.Mutex
	subscribers map[chan Event]struct{}
}

// NewEventBus creates an empty, ready-to-use EventBus.
func NewEventBus() *EventBus {
	return &EventBus{
		subscribers: make(map[chan Event]struct{}),
	}
}

// Subscribe registers a new subscriber and returns the channel that
// events published from now on will be delivered to.
func (b *EventBus) Subscribe() <-chan Event {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan Event, subscriberBuffer)
	b.subscribers[ch] = struct{}{}

	return ch
}

// Unsubscribe removes ch from the bus so it no longer receives
// published events. After Unsubscribe returns, the bus holds no
// reference to ch.
func (b *EventBus) Unsubscribe(ch <-chan Event) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for sub := range b.subscribers {
		if sub == ch {
			delete(b.subscribers, sub)
			return
		}
	}
}

// Publish delivers e to every current subscriber. If a subscriber's
// buffer is full, the event is dropped for that subscriber only -
// Publish never blocks waiting on a slow or stalled subscriber.
func (b *EventBus) Publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for ch := range b.subscribers {
		select {
		case ch <- e:
		default:
		}
	}
}
```

Why this works:

- The buffer handles short bursts. A stalled subscriber, such as
  `chStalled` in `TestPublishNeverBlocksOnStalledSubscriber`, fills its
  buffer. Later events use `default` and drop. `Publish` does not block.
- All three methods take the lock only for map changes or non-blocking
  sends.
- `Unsubscribe` deletes `sub` under the same lock as `Publish`. No later
  publish can see it.

## Approach 2: actor/monitor — single goroutine owns the state, no mutex

This design uses one goroutine, `run`, to own the subscriber map.
`Subscribe`, `Unsubscribe`, and `Publish` send commands over channels.
There is no `sync.Mutex`. Only one goroutine touches the map, so the code
does not need lock discipline.

```go {74,101}
package main

import (
	"fmt"
	"time"
)

// Event is a single message flowing through the bus.
type Event struct {
	Topic string
	Data  string
}

const subscriberBuffer = 8

// subscribeReq/unsubscribeReq are commands sent to the bus's owner
// goroutine. Nothing outside run() ever touches the subscribers map -
// state is owned by a single goroutine and shared by communicating
// with it, not by locking.
type subscribeReq struct {
	resp chan chan Event
}

type unsubscribeReq struct {
	ch   <-chan Event
	done chan struct{} // closed once removal has actually happened
}

// EventBus lets any number of subscribers listen for published
// events, supports cleanly unsubscribing, and makes sure a slow or
// stalled subscriber can never cause Publish to block. Unlike the
// mutex-protected version, there is no lock: a single goroutine (run)
// owns the subscriber set, and Subscribe/Unsubscribe/Publish talk to
// it purely via channels.
type EventBus struct {
	subscribeCh   chan subscribeReq
	unsubscribeCh chan unsubscribeReq
	publishCh     chan Event
}

// NewEventBus creates an empty, ready-to-use EventBus and starts its
// owner goroutine.
func NewEventBus() *EventBus {
	b := &EventBus{
		subscribeCh:   make(chan subscribeReq),
		unsubscribeCh: make(chan unsubscribeReq),
		publishCh:     make(chan Event),
	}
	go b.run()
	return b
}

// run is the sole owner of the subscriber set. It never blocks inside
// a case body: subscribe/unsubscribe are map operations, and publish
// only ever does non-blocking sends, so this loop is always available
// to service the next request promptly.
func (b *EventBus) run() {
	subscribers := make(map[chan Event]struct{})

	for {
		select {
		case req := <-b.subscribeCh:
			ch := make(chan Event, subscriberBuffer)
			subscribers[ch] = struct{}{}
			req.resp <- ch

		case req := <-b.unsubscribeCh:
			for sub := range subscribers {
				if sub == req.ch {
					delete(subscribers, sub)
					break
				}
			}
			close(req.done)

		case e := <-b.publishCh:
			for ch := range subscribers {
				select {
				case ch <- e:
				default:
				}
			}
		}
	}
}

// Subscribe registers a new subscriber and returns the channel that
// events published from now on will be delivered to.
func (b *EventBus) Subscribe() <-chan Event {
	resp := make(chan chan Event)
	b.subscribeCh <- subscribeReq{resp: resp}
	return <-resp
}

// Unsubscribe asks the owner goroutine to remove ch and waits for
// confirmation before returning, so the bus never sends to ch again
// once Unsubscribe has returned.
func (b *EventBus) Unsubscribe(ch <-chan Event) {
	done := make(chan struct{})
	b.unsubscribeCh <- unsubscribeReq{ch: ch, done: done}
	<-done
}

// Publish delivers e to every current subscriber. If a subscriber's
// buffer is full, the event is dropped for that subscriber only -
// Publish never blocks waiting on a slow or stalled subscriber.
func (b *EventBus) Publish(e Event) {
	b.publishCh <- e
}
```

Important details:

- `Unsubscribe` waits on `done`. `run` closes `done` only after deleting
  the entry. Without this handshake, removal could finish after
  `Unsubscribe` returns.
- `Publish` and `Subscribe` send on channels. `run` is always ready. It
  does not block inside a case, so those sends finish quickly.
- This version also needs the `sub == req.ch` comparison.

Tradeoff: this has the same behavior as Approach 1. It adds one goroutine
and three channels. It removes lock misuse by design. Approach 1 is
simpler at this scale.

## Key takeaways

- Do not hold a lock while waiting. A stalled `Publish` holds the mutex
  and stops every other method.
- Buffered channels and `select`/`default` let one slow reader fail alone.
- A `<-chan Event` cannot become a two-way channel. Compare channels with
  `==`, or key the map by the receive-only view.
- A mutex design and a single-owner goroutine design can meet the same
  contract. Choose based on which mistakes you want to prevent.
