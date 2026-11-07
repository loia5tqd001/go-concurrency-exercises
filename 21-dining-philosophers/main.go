//////////////////////////////////////////////////////////////////////
//
// Each philosopher needs the left and right fork.
// The naive code always takes the left fork first.
// Everyone can then hold one fork and wait forever.
// Your task is to prevent that deadlock for any table size.
// Keep this signature:
//
//     func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)
//

package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Fork is shared. Only one philosopher can hold it at a time.
type Fork struct {
	mu    sync.Mutex
	index int
}

// Philosopher has two forks and needs to eat a set number of meals.
type Philosopher struct {
	id                  int
	leftFork, rightFork *Fork
	mealsToEat          int
}

// Dine takes both forks, eats one meal, and records it.
func (p *Philosopher) Dine(wg *sync.WaitGroup, mealsEaten *int32) {
	defer wg.Done()

	for i := 0; i < p.mealsToEat; i++ {
		p.leftFork.mu.Lock()
		// This pause lets neighbors take their left forks.
		// The deadlock then happens reliably.
		time.Sleep(time.Millisecond)
		p.rightFork.mu.Lock()

		time.Sleep(10 * time.Microsecond)
		atomic.AddInt32(mealsEaten, 1)

		p.rightFork.mu.Unlock()
		p.leftFork.mu.Unlock()
	}
}

// Dine seats the philosophers, waits for them, and returns the meal count.
func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32) {
	forks := make([]*Fork, numPhilosophers)
	for i := range forks {
		forks[i] = &Fork{index: i}
	}

	var wg sync.WaitGroup
	var mealsEaten int32
	for i := 0; i < numPhilosophers; i++ {
		left := forks[i]
		right := forks[(i+1)%numPhilosophers]
		p := &Philosopher{id: i, leftFork: left, rightFork: right, mealsToEat: mealsToEat}
		wg.Add(1)
		go p.Dine(&wg, &mealsEaten)
	}
	wg.Wait()

	return mealsEaten
}

func main() {
	// The naive code usually deadlocks here.
	// The tests use a timeout to report the failure.
	total := Dine(5, 3)
	fmt.Printf("philosophers ate a total of %d meals\n", total)
}
