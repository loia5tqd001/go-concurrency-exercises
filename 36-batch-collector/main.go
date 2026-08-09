//////////////////////////////////////////////////////////////////////
//
// Collector is meant to coalesce many independent, concurrent calls
// into ONE call to a batch API. Imagine 30 goroutines each need a
// shipping quote for their own order, and the quoting API supports
// batch requests (send N orders, get N quotes back) but charges you a
// full round-trip for every call regardless of batch size. Calling it
// once per order wastes 29 of those round-trips; calling it once with
// all 30 orders is the efficient move - but the 30 goroutines don't
// know about each other, don't know when the 30th one shows up, and
// each still needs to get back exactly its own quote, not the whole
// batch's worth.
//
// Collector is supposed to let each goroutine call Add with its own
// request, block on the channel Add hands back, and receive exactly
// its own Result once the whole batch has run - as if it had called
// the batch API all by itself - while under the hood, fn only
// actually runs ONCE, the moment the expected-th request arrives.
//
// Right now Collector does none of that safely. Add appends to two
// shared slices and increments a shared counter with NO
// synchronization at all, from however many goroutines call it
// concurrently. That is a data race on every one of those fields, and
// it doesn't fail gracefully: lost increments can mean nQueued never
// actually reaches expected, so fn never runs and every caller's
// channel blocks forever; corrupted slices can panic outright; and if
// you "fix" this by simply wrapping the increment in a mutex without
// thinking about WHEN the batch is allowed to fire, you can just as
// easily end up calling fn twice for the same batch instead.
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
