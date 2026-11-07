//////////////////////////////////////////////////////////////////////
//
// Make Subscribe, Unsubscribe, and Publish safe for concurrent use.
// Unsubscribe must remove the channel and stop all future delivery.
// Give each subscriber a small buffer, such as 8 events.
// If a buffer is full, drop that event with a non-blocking send.
// A slow subscriber must not block Publish or other subscribers.
//
//     func NewEventBus() *EventBus
//     func (b *EventBus) Subscribe() <-chan Event
//     func (b *EventBus) Unsubscribe(ch <-chan Event)
//     func (b *EventBus) Publish(e Event)
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Event is one published message.
type Event struct {
	Topic string
	Data  string
}

// EventBus sends events to independent subscribers.
// The naive version has no unsubscribe and blocking sends.
type EventBus struct {
	mu          sync.Mutex
	subscribers []chan Event
}

// NewEventBus creates an empty bus.
func NewEventBus() *EventBus {
	return &EventBus{}
}

// Subscribe adds a subscriber and returns its channel.
func (b *EventBus) Subscribe() <-chan Event {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan Event)
	b.subscribers = append(b.subscribers, ch)

	return ch
}

func (b *EventBus) Unsubscribe(ch <-chan Event) {
}

// Publish delivers e without waiting for slow subscribers.
func (b *EventBus) Publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, ch := range b.subscribers {
		ch <- e
	}
}

func main() {
	bus := NewEventBus()

	subA := bus.Subscribe()
	subB := bus.Subscribe()

	go func() {
		for e := range subA {
			fmt.Printf("subscriber A got: %s/%s\n", e.Topic, e.Data)
		}
	}()

	go func() {
		for e := range subB {
			fmt.Printf("subscriber B got: %s/%s\n", e.Topic, e.Data)
		}
	}()

	for i := 0; i < 3; i++ {
		bus.Publish(Event{Topic: "orders", Data: fmt.Sprintf("event-%d", i)})
		time.Sleep(10 * time.Millisecond)
	}

	// The naive version cannot close these subscriber channels.
	time.Sleep(50 * time.Millisecond)
}
