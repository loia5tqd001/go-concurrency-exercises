//////////////////////////////////////////////////////////////////////
//
// This exercise picks up right where 14-tee-channel left off. Given
// below is a complete, correct answer to THAT exercise: `Tee` holds
// each value it reads from `in` and, using an inner select with a
// nilled-out-on-send local channel per output, sends it to whichever
// of out1/out2 hasn't received it yet - so writing to one output never
// has to happen strictly before the other - until both have. It
// respects `done` throughout, abandoning early and closing both
// outputs the moment `done` fires. None of that needs fixing.
//
// What it DOESN'T do is close each output independently once `in` is
// exhausted normally (not via `done`). Right now, closing is gated on
// the SLOWEST consumer: a single goroutine holds value N until BOTH
// out1 and out2 have received it before it will even look at value
// N+1, and only closes both channels together, once, after the loop
// ends. So if one consumer has already received every value the
// sensor will ever produce, but the other consumer hasn't read
// anything at all yet, the fast consumer's channel still won't close -
// the single delivery goroutine is stuck trying to hand still-pending
// values to the untouched slow side first.
//
// Your task is to make each output close ON ITS OWN, the moment every
// value has actually reached it, independent of the other output's
// progress:
//
//   - If `done` fires, keep abandoning everything and closing both
//     outputs right away, regardless of how much of `in` has been
//     delivered - this part is already correct.
//   - Otherwise, once `in` is exhausted, out1 must close as soon as
//     it - specifically - has received every value, without waiting
//     for out2 to catch up, and vice versa. A fast consumer that has
//     already received everything must see its channel close
//     immediately, even if the other consumer hasn't read a single
//     value and is sitting on a full backlog.
//
// This requires more than a tweak to the closing code: holding each
// value until BOTH outputs receive it, one value at a time in a single
// goroutine, structurally cannot let one output run arbitrarily far
// ahead of a completely unread other - the goroutine is always parked
// on the slower side's send. Making closing independent means letting
// delivery to each output progress independently too.
//
// The function signature must stay the same:
//
//     func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int)
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Tee duplicates every value read from `in` onto two independent
// output channels, so that two consumers can each observe the full
// sequence of values `in` produces, in order, regardless of how fast
// or slow either one reads. If `done` fires, both outputs close right
// away. Otherwise, once `in` is exhausted, both outputs close together
// - gated on whichever consumer is slowest, which is the part that
// needs fixing.
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

func main() {
	done := make(chan struct{})
	defer close(done)

	in := StartSensor(done, 10)
	out1, out2 := Tee(done, in)

	start := time.Now()

	var wg sync.WaitGroup
	var fast []int

	wg.Add(1)
	go func() {
		defer wg.Done()
		for v := range out1 {
			fast = append(fast, v)
		}
		fmt.Printf("out1 fully drained and closed after %s\n", time.Since(start))
	}()

	// out2 is a silent consumer: it doesn't start reading at all until
	// well after out1 should have received everything. out1 closing
	// should not have to wait on this.
	time.Sleep(200 * time.Millisecond)
	var slow []int
	for v := range out2 {
		slow = append(slow, v)
	}

	wg.Wait()

	fmt.Println("out1:", fast)
	fmt.Println("out2:", slow)
}
