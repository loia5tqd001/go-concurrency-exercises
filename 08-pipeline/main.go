//////////////////////////////////////////////////////////////////////
//
// The pipeline has three stages:
//
//  1. generator makes numbers.
//  2. square squares each number.
//  3. keepEven keeps even results.
//
// The current code runs each stage on the whole slice.
// Stages do not overlap. done is ignored.
//
// Change each stage into a goroutine connected by channels.
// Each stage must close its output and respect done.
//
// Keep these signatures:
//
//     func generator(done <-chan struct{}, nums ...int) <-chan int
//     func square(done <-chan struct{}, in <-chan int) <-chan int
//     func keepEven(done <-chan struct{}, in <-chan int) <-chan int
//
// Each stage calls SimulateWork once per item.
// Pipeline returns the final slice and keeps its signature:
//
//     func Pipeline(done <-chan struct{}, nums ...int) []int
//

package main

import "fmt"

// generator currently returns the input slice.
func generator(done <-chan struct{}, nums ...int) []int {
	return nums
}

// square currently processes the whole slice.
func square(done <-chan struct{}, nums []int) []int {
	out := make([]int, len(nums))
	for i, n := range nums {
		SimulateWork()
		out[i] = n * n
	}
	return out
}

// keepEven currently filters the whole slice.
func keepEven(done <-chan struct{}, nums []int) []int {
	var out []int
	for _, n := range nums {
		SimulateWork()
		if n%2 == 0 {
			out = append(out, n)
		}
	}
	return out
}

// Pipeline runs nums through all three stages.
func Pipeline(done <-chan struct{}, nums ...int) []int {
	return keepEven(done, square(done, generator(done, nums...)))
}

func main() {
	done := make(chan struct{})
	defer close(done)

	result := Pipeline(done, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)

	fmt.Println(result)
}
