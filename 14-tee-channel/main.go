//////////////////////////////////////////////////////////////////////
//
// Send every input value to both outputs in order.
// Each output needs its own independent copy.
// One slow reader must not prevent the other output from receiving.
// Stop and close both outputs when done closes.
//
//     func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int)
//

package main

import (
	"fmt"
	"sync"
)

// Tee must deliver each input value to both outputs.
// The naive version returns the same input channel twice.
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
	return in, in
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
