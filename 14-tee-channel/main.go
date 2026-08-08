//////////////////////////////////////////////////////////////////////
//
// Given is a function StartSensor (see mocksensor.go) that simulates a
// hardware sensor: it emits `count` incrementing integer readings, one
// every 5ms, then closes its channel. Two independent consumers need
// to see the full stream - say, a live display and a logger - and one
// of them might read slower than the other.
//
// Tee is supposed to duplicate every value read from `in` so that TWO
// independent consumers can each see the full sequence, even if one
// consumer reads slower than the other. Right now it does nothing of
// the sort - it just returns the same input channel twice, which means
// the two "outputs" are actually the SAME channel: whichever consumer
// happens to read a given value first gets it, and the other consumer
// never sees that value at all. Values get split between the two
// consumers instead of duplicated to both.
//
// Your task is to implement Tee properly: every value received from
// `in` must be sent to BOTH output channels, so each output ends up
// with the full, identical sequence of values `in` produced, in order.
// For each value, hold onto it and, using an inner select per output
// channel (so writing to one output doesn't have to happen strictly
// before the other, and a slow reader on one output doesn't stall
// forever if `done` fires), send it to whichever output(s) haven't
// received it yet, until both have. Respect `done` throughout,
// abandoning early if it closes. Close both output channels once `in`
// is exhausted (or `done` fires). The function signature must stay the
// same:
//
//     func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int)
//
// so that it remains a drop-in replacement for the passthrough version
// below.
//

package main

import (
	"fmt"
	"sync"
)

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

func LoopSliceConcurrently[T any](arr []T, itemFn func(index int, item T)) {
	var wg sync.WaitGroup
	for index, item := range arr {
		wg.Go(func() {
			itemFn(index, item)
		})
	}
	wg.Wait()
}

func LoopChanConcurrently[T any, TChan ~chan T | ~<-chan T](channel TChan, itemFn func(item T)) {
	var wg sync.WaitGroup
	for item := range channel {
		wg.Go(func() {
			itemFn(item)
		})
	}
	wg.Wait()
}

// Tee is supposed to duplicate every value read from `in` so that TWO
// independent consumers can each see the full sequence, even if one
// consumer reads slower than the other. Right now it does nothing of
// the sort - it just returns the same input channel twice, which means
// the two "outputs" are actually the SAME channel: whichever consumer
// happens to read a given value first gets it, and the other consumer
// never sees that value at all. Values get split between the two
// consumers instead of duplicated to both.
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	out := make([]chan int, 2)

	for i := range out {
		out[i] = make(chan int)
	}

	go func() {
		// var wg sync.WaitGroup
		// // TODO: close each channel individually early
		// defer func() {
		// 	for i := range out {
		// 		close(out[i])
		// 	}
		// }()

		// ===== My first attempt that didn't pass the strict requirement + use Loop...Concurrently util
		// LoopChanConcurrently(orDone(done, in), func(value int) {
		// 	LoopSliceConcurrently(out, func(index int, outChan chan int) {
		// 		select {
		// 		case <-done:
		// 			return
		// 		case outChan <- value:
		// 		}
		// 	})
		// })

		// ===== My first attempt that didn't pass the strict requirement
		// for value := range orDone(done, in) {
		// 	wg.Go(func() {
		// 		var wg2 sync.WaitGroup
		// 		for i := range out {
		// 			wg2.Go(func() {
		// 				select {
		// 				case <-done:
		// 					return
		// 				case out[i] <- value:
		// 				}
		// 			})
		// 		}
		// 		wg2.Wait()
		// 	})
		// }
		// wg.Wait()

		// ===== BEST SOLUTION (Approach 2 from Solution)
		wgs := make([]sync.WaitGroup, len(out))
		for value := range orDone(done, in) {
			for i := range out {
				wgs[i].Go(func() {
					select {
					case <-done:
						return
					case out[i] <- value:
					}
				})
			}
		}
		for i := range out {
			go func() {
				wgs[i].Wait()
				close(out[i])
			}()
		}

		// ===== My own attempts without orDone that passed all test cases
		// wgs := make([]sync.WaitGroup, len(out))
		// drainAndCloseOutChannelsConcurrently := func() {
		// 	for i := range out {
		// 		go func() {
		// 			wgs[i].Wait()
		// 			close(out[i])
		// 		}()
		// 	}
		// }
		// for {
		// 	select {
		// 	case <-done:
		// 		drainAndCloseOutChannelsConcurrently()
		// 		return
		// 	case value, ok := <-in:
		// 		if !ok {
		// 			drainAndCloseOutChannelsConcurrently()
		// 			return
		// 		}
		// 		for i := range out {
		// 			wgs[i].Go(func() {
		// 				select {
		// 				case <-done:
		// 					return
		// 				case out[i] <- value:
		// 				}
		// 			})
		// 		}
		// 	}
		// }
	}()

	return out[0], out[1]
}

func main() {
	done := make(chan struct{})
	defer close(done)

	in := StartSensor(10)
	out1, out2 := Tee(done, in)

	var wg sync.WaitGroup
	var fast, slow []int

	wg.Go(func() {
		for v := range out1 {
			fast = append(fast, v)
		}
	})

	wg.Go(func() {
		for v := range out2 {
			slow = append(slow, v)
		}
	})

	wg.Wait()

	fmt.Println("consumer 1:", fast)
	fmt.Println("consumer 2:", slow)
}
