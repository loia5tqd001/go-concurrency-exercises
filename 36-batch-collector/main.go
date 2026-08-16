//////////////////////////////////////////////////////////////////////
//
// Collector coalesces many independent, concurrent calls into batch
// API calls - and, unlike a one-shot join, keeps doing it for as long
// as the process is running:
//
//   Add(order 0) ─┐
//   Add(order 1) ─┼─▶ buffer requests ──MaxBatchSize-th Add, OR────▶ fn(batch) ── fires,
//   Add(order 2) ─┘    MaxWait elapses since the batch's 1st Add     then a fresh
//                                          fan back out, each caller  batch opens
//                                          gets its own matching
//                                          response
//
// Imagine 30 goroutines each needing a shipping quote for their own
// order, from an API that supports batches (N orders in, N quotes
// out) but charges a full round-trip per call regardless of size, and
// this keeps happening for as long as the service is up - not just
// once. One batched call is the efficient move - but the 30
// goroutines don't know about each other, don't know when the 30th
// shows up, and each still needs exactly its own quote back. And a
// batch that's still short of 30 when traffic goes quiet can't just
// wait forever either - every caller needs their answer within some
// bounded latency, full batch or not.
//
// Right now Collector only knows how to do the first part, badly:
//
//   - Add appends to two shared slices with NO synchronization at
//     all, from however many goroutines call it - a data race on
//     every field.
//   - MaxWait is accepted in Config and never used. A batch that never
//     reaches MaxBatchSize just sits there forever - every caller in
//     it blocks with no way out.
//   - Close sets a bool and returns immediately. It doesn't stop Add
//     from still accepting requests into a batch nobody will ever
//     flush, doesn't fire whatever's already queued, and doesn't wait
//     for a batch that's mid-flight to actually finish.
//
// Your task is to fix Collector so that:
//
//   - Add(request int) <-chan Result registers request as part of
//     whichever batch is currently open and returns a channel that
//     will receive exactly one Result once that batch has run.
//   - Add is safe to call concurrently, from any number of goroutines,
//     for as long as the Collector hasn't been closed.
//   - A batch fires - runs fn exactly once, with every request queued
//     into it so far, in the order Add was called for each of them -
//     the moment EITHER its MaxBatchSize-th request arrives OR
//     MaxWait has elapsed since its first request, whichever happens
//     first. A batch that hits neither trigger twice: fn must never
//     run twice for the same batch, no matter which trigger wins or
//     how close the timing.
//   - The moment one batch fires, the Collector opens a fresh one -
//     it keeps doing this indefinitely, not just once. Every caller
//     gets back the Result at fn's response index matching the
//     position ITS OWN request ended up at in ITS OWN batch - never
//     another caller's, and never another batch's.
//   - If fn returns an error, every caller in that batch receives that
//     same error in its Result, instead of a value.
//   - Close(ctx) stops the Collector from accepting any further Add
//     calls (each returns ErrCollectorClosed immediately instead), and
//     fires whatever's currently queued as one last partial batch
//     instead of abandoning it. Close blocks until every batch it
//     ever started - including one already racing to fire the instant
//     Close was called - has actually finished running fn, or returns
//     ctx's error if ctx is done first (the in-flight batch keeps
//     running in the background regardless; Close just stops waiting
//     on it). Close is safe to call more than once, and concurrently
//     with Add and with itself.
//
// The signatures must stay the same:
//
//     func NewCollector(cfg Config, fn BatchFunc) *Collector
//     func (c *Collector) Add(request int) <-chan Result
//     func (c *Collector) Close(ctx context.Context) error
//

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// BatchFunc processes an entire batch of requests in one call.
// responses[i] must be the result for requests[i] - the ordering
// between the two slices matters.
type BatchFunc func(requests []int) (responses []int, err error)

// Result is what a single caller receives back for its own request,
// once the batch it was part of has been executed.
type Result struct {
	Value int
	Err   error
}

// ErrCollectorClosed is the error every Add call gets back once Close
// has been called - a closed Collector never accepts another request.
var ErrCollectorClosed = errors.New("collector: closed")

// Config controls when a batch fires - whichever bound is hit first.
type Config struct {
	// MaxBatchSize is how many requests trigger an immediate fire.
	MaxBatchSize int
	// MaxWait bounds how long a batch waits for more requests before
	// firing anyway, once its first request has arrived. Zero means no
	// deadline - the batch only ever fires by reaching MaxBatchSize.
	MaxWait time.Duration
}

// Collector coalesces many independent calls to Add into batch calls
// to fn, fans each batch's per-request responses (or a shared error)
// back out through every caller's own channel, and keeps doing this
// for as long as it hasn't been Closed.
type Collector struct {
	cfg Config
	fn  BatchFunc

	requests  []int
	resultChs []chan Result
	closed    bool
}

// NewCollector returns a Collector that batches calls to Add per cfg,
// running fn once per batch.
func NewCollector(cfg Config, fn BatchFunc) *Collector {
	return &Collector{cfg: cfg, fn: fn}
}

// Add registers request as part of the currently-open batch and
// returns a channel that will receive exactly one Result once that
// batch has run. Add may be called concurrently, from any number of
// goroutines.
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	c.requests = append(c.requests, request)
	c.resultChs = append(c.resultChs, ch)

	if len(c.requests) >= c.cfg.MaxBatchSize {
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

	c.requests = nil
	c.resultChs = nil
}

// Close stops the Collector from accepting new requests.
func (c *Collector) Close(ctx context.Context) error {
	c.closed = true
	return nil
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

	c := NewCollector(Config{MaxBatchSize: 5, MaxWait: 200 * time.Millisecond}, double)

	// 12 concurrent requests against a batch size of 5: two full
	// batches plus a straggling partial one that only MaxWait can
	// rescue.
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
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
