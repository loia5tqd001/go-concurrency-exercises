# Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `14b-tee-channel-independent-close/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

This exercise follows [14](../14-tee-channel). The starting code in
`main.go` is already a correct answer to 14:

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

For each value, an inner `select` races both sends. It sets each local
channel variable to nil after that output receives the value. A nil
channel is never selected. One output does not have to finish before the
other. `done` is checked while reading and sending. Do not change this
part.

The close waits for the slowest consumer. One goroutine holds value N
until `out1Ch` and `out2Ch` both become nil. It then reads value N+1. It
closes both channels together after the loop.

`out1` and `out2` are independent consumers. If one receives every value
and the other reads nothing, the fast channel stays open. The goroutine
waits to hand pending values to the slow side.

`check_test.go` has the same tests as 14 and one more.
`TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` drains one output and
never reads the other. It requires the drained output to be closed. It
tests both directions, so a special case for index 0 cannot pass.

## Why the given starting code isn't enough

Verified in a scratch copy. `TestTeeDuplicatesToBothConsumers(ReversedRoles)`,
`TestTeeDeliversToOneOutputWithoutWaitingOnTheOther`, and
`TestTeeStopsOnDone(Race)` pass. The code meets 14's rules. The inner
`select` races both sends.

`TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered` fails. The design
causes this, not a small close-code bug:

```
--- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered (0.00s)
    --- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out1_is_the_fast_one (0.00s)
        check_test.go:314: no value received within 20ms - is delivery to this output waiting on some other output being read first?
    --- FAIL: TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered/out2_is_the_fast_one (0.00s)
        check_test.go:314: no value received within 20ms - is delivery to this output waiting on some other output being read first?
```

The second `receiveWithTimeout` on the fast output times out. The
goroutine is still sending value 0 to the slow side. It has not read
value 1.

One goroutine cannot let one output move far ahead when it holds each
value for both outputs. Changing the close code will not fix that design.

`StartSensor` checks `done`, which the test closes with `defer`.
`receiveWithTimeout` uses `t.Fatalf` only for this subtest. It runs under
`synctest`.
`TestTeeStopsOnDone` and `TestTeeStopsOnDoneRace` still pass.

The fix must remove this single-goroutine model. Let each output deliver
independently.

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

- **Each output has one long-lived forwarder.** The reader appends to
  each FIFO and does not wait for either consumer.
- **Order comes from the FIFO.** Each output has one queue and one
  forwarder. Values reach the output in push order.
- **Each output owns its close.** Call `close` on the queue to wake its
  forwarder. The forwarder drains the FIFO and closes the output. The
  other output is not affected.
- **`done` has one cleanup path.** The reader's deferred queue close
  wakes both forwarders. Each blocked send also checks `done`.

A silent consumer can grow its queue without limit. The test stream is
bounded, so that is fine here. A production stream would need an item
limit or backpressure.

**Verified:** in a scratch copy, the scaffold fails
`TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered`. This FIFO version
passes all six tests under `go test -race -count=20 ./...`.
`go vet ./...` is clean.

## Key takeaways

- One goroutine that waits for both consumers cannot close outputs
  independently.
- Use a FIFO and forwarder per output when order and independent progress
  both matter.
- Check `done` in delivery. Close every queue during cleanup.
- A timed test does not prove order if scheduling controls it.
