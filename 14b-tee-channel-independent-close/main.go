//////////////////////////////////////////////////////////////////////
//
// Tee from exercise 14 already copies values and handles done.
// Now each output must close on its own after receiving every value.
// A fast output must not wait for an unread slow output.
// Delivery to each output must also make progress independently.
// One shared loop cannot let a fast output move far ahead.
//
//     func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int)
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Tee sends every input value to both outputs.
// The naive version closes both outputs together.
// That makes a fast output wait for a slow output.
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

	// Start out2 late so out1 must close without waiting.
	time.Sleep(200 * time.Millisecond)
	var slow []int
	for v := range out2 {
		slow = append(slow, v)
	}

	wg.Wait()

	fmt.Println("out1:", fast)
	fmt.Println("out2:", slow)
}
