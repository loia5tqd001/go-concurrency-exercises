# Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `14b-tee-channel-independent-close/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

This exercise picks up where [14](../14-tee-channel) left off. The given starting point is already a complete, correct answer to 14 itself:

```go {23}
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	out1 := make(chan int)
	out2 := make(chan int)

	go func() {
		defer close(out1)
		defer close(out2)

		for {
			var v int
			var ok bool

			select {
			case <-done:
				return
			case v, ok = <-in:
				if !ok {
					return
				}
			}

			out1Ch, out2Ch := out1, out2
			for out1Ch != nil || out2Ch != nil {
				select {
				case out1Ch <- v:
					out1Ch = nil
				case out2Ch <- v:
					out2Ch = nil
				case <-done:
					return
				}
			}
		}
	}()

	return out1, out2
}
```

For each value, an inner `select` races both sends, nilling out whichever local channel variable has already received the current value (a nil channel is never selectable, so it drops out of the `select` for good) — so writing to one output never has to happen strictly before the other. `done` is checked in both the outer receive loop and the inner send loop, so shutdown is prompt either way. None of this needs fixing.

What's missing: closing is gated on the **slowest** consumer. The single goroutine above holds value N until *both* `out1Ch` and `out2Ch` have gone nil (i.e., both outputs received it) before it even looks at value N+1, and only closes both channels together, once, after the loop returns. If one consumer has already received every value the sensor will ever produce but the other hasn't read anything, the fast consumer's channel still won't close — the goroutine is stuck trying to hand still-pending values to the untouched side first.

`check_test.go` (identical to 14's, plus one additional test) checks this directly: `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` drains one output *completely* while the other is never read, then asserts the drained one is already closed. It runs in both directions (`out1` fast/`out2` slow, and vice versa) so an implementation that special-cases index 0 can't sneak by either.

## Why the given starting code isn't enough

Verified against the given `main.go` in a throwaway scratch copy: `TestTeeDuplicatesToBothConsumers(ReversedRoles)`, `TestTeeDeliversToOneOutputWithoutWaitingOnTheOther`, and `TestTeeStopsOnDone(Race)` all pass — this code is a genuinely correct answer to 14's requirements, including the "no fixed try-order" property, since the inner `select` really does race both sends rather than attempting them in sequence.

`TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` fails, and for a structural reason, not a closing-logic bug per se:

```
--- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered (0.00s)
    --- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out1_is_the_fast_one (0.00s)
        check_test.go:314: no value received within 20ms - is delivery to this output waiting on some other output being read first?
    --- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out2_is_the_fast_one (0.00s)
        check_test.go:314: no value received within 20ms - is delivery to this output waiting on some other output being read first?
```

The test's second `receiveWithTimeout` call on the fast output already times out: the delivery goroutine is still parked trying to hand value 0 to the untouched slow side and hasn't even looked at value 1 yet. "Holding each value until both outputs receive it, one value at a time, in a single goroutine" is exactly what 14 asked for — and it's precisely why this design can never let one output run more than a fraction of a value ahead of a completely unread other, no matter how the closing code is written on top of it. `StartSensor` itself also honors `done` (closed by the test's own `defer`), so `receiveWithTimeout`'s `t.Fatalf` fails just this subtest cleanly instead of leaving the sensor's goroutine blocked forever inside the `synctest` bubble — the remaining tests, `TestTeeStopsOnDone` and `TestTeeStopsOnDoneRace`, still run and pass.

So fixing this needs more than moving the `close` calls around — it needs abandoning the single-goroutine, hold-until-both-received-it model in favor of letting each output's delivery progress independently.

## The fix: per-output completion tracking, independent closers

```go {39,48,61,62}
package main

import (
	"fmt"
	"sync"
)

// orDone adapts a channel so ranging over it also stops when done
// fires, not just when the channel closes.
func orDone[T any](done <-chan struct{}, c <-chan T) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for {
			select {
			case <-done:
				return
			case value, ok := <-c:
				if !ok {
					return
				}
				select {
				case out <- value:
				case <-done:
					return
				}
			}
		}
	}()
	return out
}

type outputQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	values []int
	closed bool
}

func newOutputQueue() *outputQueue {
	q := &outputQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *outputQueue) push(value int) {
	q.mu.Lock()
	q.values = append(q.values, value)
	q.cond.Signal()
	q.mu.Unlock()
}

func (q *outputQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *outputQueue) next() (int, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.values) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.values) == 0 {
		return 0, false
	}
	value := q.values[0]
	q.values[0] = 0
	q.values = q.values[1:]
	return value, true
}

func forwardOutput(done <-chan struct{}, out chan<- int, q *outputQueue) {
	defer close(out)
	for {
		value, ok := q.next()
		if !ok {
			return
		}
		select {
		case out <- value:
		case <-done:
			return
		}
	}
}

// Tee duplicates every value read from `in` onto two independent
// output channels. Each output has its own FIFO queue and forwarder,
// so either output can close without waiting for the other consumer.
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	out := make([]chan int, 2)
	queues := make([]*outputQueue, 2)
	for i := range out {
		out[i] = make(chan int)
		queues[i] = newOutputQueue()
		go forwardOutput(done, out[i], queues[i])
	}

	go func() {
		defer queues[0].close()
		defer queues[1].close()
		for {
			select {
			case <-done:
				return
			case value, ok := <-in:
				if !ok {
					return
				}
				queues[0].push(value)
				queues[1].push(value)
			}
		}
	}()

	return out[0], out[1]
}
```

Design notes:

- **One long-lived forwarder per output.** The reader only appends to each output's FIFO; it never waits for either consumer. This keeps delivery to one output independent from a slow or silent consumer on the other.
- **Ordering is structural.** Every output has one queue and one forwarder, so values reach that output in push order. It does not depend on separate goroutines racing to send to the same channel.
- **Each output owns its close.** Closing its queue makes its forwarder drain the remaining FIFO and close the output. The other output is unaffected.
- **`done` has one cleanup path.** The reader's deferred queue closes wake both forwarders even when cancellation happens before `in` is exhausted, and each blocked send also selects on `done`.

The tradeoff is that a silent consumer can make its queue grow without bound. The exercise's bounded test stream makes that acceptable here; a production stream with unbounded producers would need a byte/item limit or backpressure policy.

**Verified** in a scratch copy of `14b-tee-channel-independent-close/`: the scaffold fails `TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered`; this FIFO-forwarder version passes the full six-test suite under `go test -race -count=20 ./...`, with `go vet ./...` clean.

## Key takeaways

- One goroutine that waits for both consumers before moving to the next value cannot let the outputs close independently.
- Give each output its own FIFO and forwarder when independent progress and ordering both matter.
- Keep shutdown in the delivery select and make cleanup close every queue.
- A passing paced test does not prove ordering if the implementation relies on goroutine scheduling.
