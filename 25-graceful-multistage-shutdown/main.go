//////////////////////////////////////////////////////////////////////
//
// Start runs a fixed pool of workers.
// Each worker calls process for every job it receives.
// The current done channel closes before the work finishes.
//
// A caller can then close a file or connection too early.
// Your task is to close done only after every worker finishes.
// Start must still return right away.
// Keep this signature:
//
//     func Start(jobs <-chan int, process func(item int)) <-chan struct{}
//
// The tests use this exact signature.
//

package main

import (
	"fmt"
	"time"
)

const numWorkers = 4

// Start launches the workers and returns a done channel.
// Done should close only after every process call returns.
func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
	for i := 0; i < numWorkers; i++ {
		go func() {
			for item := range jobs {
				process(item)
			}
		}()
	}

	done := make(chan struct{})
	close(done)
	return done
}

func main() {
	const numJobs = 20

	jobs := make(chan int)

	go func() {
		for i := 0; i < numJobs; i++ {
			jobs <- i
		}
		close(jobs)
	}()

	done := Start(jobs, func(item int) {
		// Slow work shows that done closes too early.
		time.Sleep(10 * time.Millisecond)
		fmt.Println("processed", item)
	})

	<-done
	fmt.Println("shutdown complete")
}
