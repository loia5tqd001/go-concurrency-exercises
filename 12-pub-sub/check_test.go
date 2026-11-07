//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// recvWithTimeout prevents a broken implementation from hanging the test.
func recvWithTimeout(t *testing.T, ch <-chan Event, d time.Duration) (Event, bool) {
	t.Helper()

	select {
	case e, ok := <-ch:
		return e, ok
	case <-time.After(d):
		return Event{}, false
	}
}

// TestPubSubBasicDelivery checks two subscribers receive all events in order.
func TestPubSubBasicDelivery(t *testing.T) {
	bus := NewEventBus()

	subA := bus.Subscribe()
	subB := bus.Subscribe()

	events := []Event{
		{Topic: "orders", Data: "1"},
		{Topic: "orders", Data: "2"},
		{Topic: "orders", Data: "3"},
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, e := range events {
			bus.Publish(e)
		}
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish did not return in time")
	}

	for i, want := range events {
		gotA, ok := recvWithTimeout(t, subA, time.Second)
		if !ok {
			t.Fatalf("subscriber A: timed out waiting for event %d", i)
		}
		if gotA != want {
			t.Errorf("subscriber A: event %d = %+v, want %+v", i, gotA, want)
		}

		gotB, ok := recvWithTimeout(t, subB, time.Second)
		if !ok {
			t.Fatalf("subscriber B: timed out waiting for event %d", i)
		}
		if gotB != want {
			t.Errorf("subscriber B: event %d = %+v, want %+v", i, gotB, want)
		}
	}
}

// TestUnsubscribeStopsDelivery checks only events after Unsubscribe are lost.
// Other subscribers must keep receiving events.
func TestUnsubscribeStopsDelivery(t *testing.T) {
	bus := NewEventBus()

	chA := bus.Subscribe()
	chB := bus.Subscribe()

	var mu sync.Mutex
	var gotA, gotB []Event

	stopA := make(chan struct{})
	stopB := make(chan struct{})

	go func() {
		defer close(stopA)
		for e := range chA {
			mu.Lock()
			gotA = append(gotA, e)
			mu.Unlock()
		}
	}()
	go func() {
		defer close(stopB)
		for e := range chB {
			mu.Lock()
			gotB = append(gotB, e)
			mu.Unlock()
		}
	}()

	event1 := Event{Topic: "orders", Data: "1"}
	event2 := Event{Topic: "orders", Data: "2"}

	bus.Publish(event1)
	// Let both readers drain event1 before unsubscribing A.
	time.Sleep(50 * time.Millisecond)

	bus.Unsubscribe(chA)

	bus.Publish(event2)
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(gotA) != 1 {
		t.Errorf("subscriber A received %d events after unsubscribing, want 1 (only the pre-unsubscribe event): %+v", len(gotA), gotA)
	} else if gotA[0] != event1 {
		t.Errorf("subscriber A's only event = %+v, want %+v", gotA[0], event1)
	}

	want := []Event{event1, event2}
	if len(gotB) != len(want) {
		t.Fatalf("subscriber B received %d events, want %d: %+v", len(gotB), len(want), gotB)
	}
	for i := range want {
		if gotB[i] != want[i] {
			t.Errorf("subscriber B event %d = %+v, want %+v", i, gotB[i], want[i])
		}
	}
}

// TestPublishNeverBlocksOnStalledSubscriber never reads chStalled.
// Publish must still finish by dropping events for that subscriber.
func TestPublishNeverBlocksOnStalledSubscriber(t *testing.T) {
	bus := NewEventBus()

	chFast := bus.Subscribe()
	chStalled := bus.Subscribe()
	_ = chStalled // deliberately never read from

	go func() {
		for range chFast {
			// Drain continuously.
		}
	}()

	const numEvents = 20 // Larger than any normal subscriber buffer.

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < numEvents; i++ {
			bus.Publish(Event{Topic: "orders", Data: fmt.Sprintf("event-%d", i)})
		}
	}()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Publish blocked: a stalled subscriber that never reads its channel " +
			"must not prevent Publish from returning for every other call/subscriber")
	}
}

// TestPubSubConcurrentAccess checks concurrent calls do not race or panic.
func TestPubSubConcurrentAccess(t *testing.T) {
	bus := NewEventBus()

	const goroutines = 50
	const iterations = 100

	var wg sync.WaitGroup
	wg.Add(goroutines * 3)

	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				bus.Publish(Event{Topic: "stress", Data: "x"})
			}
		}()

		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				ch := bus.Subscribe()
				// Make room in the buffer.
				select {
				case <-ch:
				default:
				}
				bus.Unsubscribe(ch)
			}
		}()

		go func() {
			defer wg.Done()
			ch := bus.Subscribe()
			for j := 0; j < iterations; j++ {
				select {
				case <-ch:
				default:
				}
			}
			bus.Unsubscribe(ch)
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent Subscribe/Unsubscribe/Publish stress test did not finish in time")
	}
}
