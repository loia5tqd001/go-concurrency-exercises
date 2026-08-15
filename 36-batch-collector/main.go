//////////////////////////////////////////////////////////////////////
//
// Collector coalesces many independent, concurrent calls into ONE
// call to a batch API:
//
//   Add(order 0) ─┐
//   Add(order 1) ─┼─▶ buffer requests ──expected-th Add──▶ fn(all) ── once
//   Add(order 2) ─┘                                            │
//                                          fan back out: each caller gets
//                                          its own matching response
//
// Imagine 30 goroutines each needing a shipping quote for their own
// order, from an API that supports batches (N orders in, N quotes
// out) but charges a full round-trip per call regardless of size. One
// batched call is the efficient move - but the 30 goroutines don't
// know about each other, don't know when the 30th shows up, and each
// still needs exactly its own quote back.
//
// Right now Add appends to two shared slices and increments a shared
// counter with NO synchronization at all. That's a data race on every
// field, and it doesn't fail gracefully: lost increments can mean
// nQueued never reaches expected (fn never runs, every caller blocks
// forever); corrupted slices can panic outright; and a mutex around
// the increment ALONE, without thinking about WHEN the batch may
// fire, can just as easily let fn run twice for the same batch.
//
// Your task is to fix Collector so that:
//
//   - Add(request int) <-chan Result registers request as part of the
//     batch and returns a channel that will receive exactly one
//     Result once the whole batch has run.
//   - Add is safe to call concurrently, from any number of goroutines,
//     for as long as there are still requests left before `expected`
//     is reached.
//   - fn runs EXACTLY ONCE, only once the expected-th call to Add has
//     arrived, with every request that was added, in the order Add
//     was called for each of them.
//   - Every caller receives back the Result at fn's response index
//     matching the position ITS OWN request ended up at in that
//     slice - not some other caller's result.
//   - If fn returns an error, every caller receives that same error
//     in its Result, instead of a value.
//
// The signature must stay the same:
//
//     func (c *Collector) Add(request int) <-chan Result
//

package main

import (
	"fmt"
	"sync"
)

// BatchFunc processes an entire batch of requests in one call.
// responses[i] must be the result for requests[i] - the ordering
// between the two slices matters.
type BatchFunc func(requests []int) (responses []int, err error)

// Result is what a single caller receives back for its own request,
// once the whole batch it was part of has been executed.
type Result struct {
	Value int
	Err   error
}

// Collector coalesces `expected` independent calls to Add into a
// single call to fn, then fans the per-request responses (or a shared
// error) back out through each caller's own channel.
type Collector struct {
	expected  int
	fn        BatchFunc
	requests  []int
	resultChs []chan Result
	nQueued   int
}

// NewCollector returns a Collector that runs fn exactly once, as soon
// as `expected` requests have been added to it.
func NewCollector(expected int, fn BatchFunc) *Collector {
	return &Collector{expected: expected, fn: fn}
}

// Add registers request as part of the batch and returns a channel
// that will receive exactly one Result once the whole batch has run.
// Add may be called concurrently, from any number of goroutines.
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)
	c.nQueued++

	if c.nQueued >= c.expected {
		c.execute()
	}

	return ch
}

// execute runs fn against every request queued so far and delivers
// each response back through its matching caller's channel.
func (c *Collector) execute() {
	responses, err := c.fn(c.requests)

	for i, resultCh := range c.resultChs {
		if err != nil {
			resultCh <- Result{Err: err}
			continue
		}
		resultCh <- Result{Value: responses[i]}
	}
}

func main() {
	double := func(requests []int) (responses []int, err error) {
		fmt.Printf("batch API called with %v\n", requests)

		responses = make([]int, len(requests))
		for i, r := range requests {
			responses[i] = r * 2
		}
		return responses, nil
	}

	const callers = 5
	c := NewCollector(callers, double)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			result := <-c.Add(i)
			fmt.Printf("caller %d: got %d (err=%v)\n", i, result.Value, result.Err)
		}()
	}

	wg.Wait()
}
