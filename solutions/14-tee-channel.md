# Tee Channel: Duplicating a Sensor Stream to Two Consumers — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `14-tee-channel/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`StartSensor` in `mocksensor.go` sends `count` increasing readings. The
signature is `StartSensor(count)`. It sends one every 5ms and then
closes the channel. `Tee` must copy every value from `in` to two outputs.
Both consumers need the full order, even if one reads slowly. Closing
`done` must stop `Tee` and close both outputs.

The naive implementation is:

```go
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	return in, in
}
```

## Why the naive version is wrong

`out1` and `out2` are the same channel as `in`. Each value goes to only
one receiving goroutine. `TestTeeDuplicatesToBothConsumers` in
`check_test.go` proves this.
It drains `out1` quickly and reads `out2` with a 2ms delay. Both must get
the full `[0..9]` sequence.

Verified against the naive version in a scratch copy:

```
--- FAIL: TestTeeDuplicatesToBothConsumers (0.00s)
    check_test.go:77: fast consumer got [1 3 5 7 9], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
    check_test.go:80: slow consumer got [0 2 4 6 8], want [0 1 2 3 4 5 6 7 8 9] (every value must reach every consumer)
--- FAIL: TestTeeStopsOnDone (0.03s)
    check_test.go:138: expected out1 to be closed once done fires, got value 4 instead
--- FAIL: TestTeeStopsOnDoneRace (0.03s)
    check_test.go:147: expected out1 to be closed once done fires, got value 4 instead
```

The fast consumer gets odd values. The slow one gets even values. Both
are missing half. `reflect.DeepEqual` against `[0..9]` fails.

`TestTeeStopsOnDone` also fails. `out1` and `out2` are `in`. Closing
`done` does nothing. The next read returns a sensor value, not a closed
channel.

## Approach 1: per-value goroutine, inner select with nil-out-on-send

There is only one common shape for `Tee`. Hold each value until both
outputs receive it. Use an inner loop so one slow reader cannot block
the other output or ignore `done`.

For each value, make two local variables from `out1` and `out2`. Set
each one to nil after its output receives the value. A nil channel is
never ready in a `select`. The inner loop ends when both are nil or
`done` closes.

```go {38,42,44}
package main

import (
	"fmt"
	"sync"
)

// Tee duplicates every value read from `in` onto two independent
// output channels, so that two consumers can each observe the full
// sequence of values `in` produces, in order, regardless of how fast
// or slow either one reads. It closes both outputs once `in` is
// exhausted or done fires.
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

			// Send v to whichever of out1/out2 hasn't received it yet,
			// using a separate select per output so that a slow reader
			// on one output doesn't block delivery to the other, and
			// done still gets a chance to fire while we wait.
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

func main() {
	done := make(chan struct{})
	defer close(done)

	in := StartSensor(10)
	out1, out2 := Tee(done, in)

	var wg sync.WaitGroup
	var fast, slow []int

	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range out1 {
			fast = append(fast, v)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range out2 {
			slow = append(slow, v)
		}
	}()

	wg.Wait()

	fmt.Println("consumer 1:", fast)
	fmt.Println("consumer 2:", slow)
}
```

Why this shape:

- Only one goroutine reads `in`. Two readers could split values again.
- Set the local `out1Ch` and `out2Ch` to nil, not the real `out1` and
  `out2`. The `select` then stops choosing that output.
- Check `done` with `<-done` or `case <-done` while reading and sending.
  If `done` closes while a slow consumer is unread, the send must still
  stop. The other send can use `out2Ch <- v`.
- Defer `close(out1)` and `close(out2)`. Every return path closes both
  channels once. Consumers can end their `range` loops.

**Verified:** in a scratch copy, the starting `main.go` failed
`TestTeeDuplicatesToBothConsumers`, `TestTeeStopsOnDone`, and
`TestTeeStopsOnDoneRace`. This solution passed
`go test -race -count=5 ./...` in all 5 runs.

## Key takeaways

- `return in, in` is not duplication. It returns one channel twice.
- Hold each value until both outputs receive it. Use an inner `select`.
  Do not use fixed blocking sends.
- Set each local output variable to nil after delivery. A nil channel is
  never selected.
- Check `done` while sending inside the per-value loop. Without it, one
  stalled consumer can block shutdown.
