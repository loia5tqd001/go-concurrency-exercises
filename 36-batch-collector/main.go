//////////////////////////////////////////////////////////////////////
//
// Collector groups concurrent requests into batches.
// It keeps opening new batches until Close.
//
// Add calls -> open batch -> fn(batch) -> one Result per caller
//
// A batch fires when its size reaches MaxBatchSize.
// It also fires when MaxWait passes from its first request.
//
// The current version does not batch:
// - Add calls fn once for every request.
// - MaxBatchSize and MaxWait are ignored.
// - Close does nothing.
//
// Fix Collector so:
// - Add is safe to call concurrently.
// - fn runs once for each batch.
// - Each caller gets its own response.
// - A shared error reaches every caller in the batch.
// - A new batch opens after each fire.
// - Close rejects later Adds and flushes the pending batch.
// - Close waits for started batches, unless ctx ends first.
// - Close is idempotent and safe during Add calls.
//
// Keep the signatures:
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

// BatchFunc processes a batch in one call.
// responses[i] must match requests[i].
type BatchFunc func(requests []int) (responses []int, err error)

// Result is the value or error for one caller.
type Result struct {
	Value int
	Err   error
}

// ErrCollectorClosed means the Collector no longer accepts requests.
var ErrCollectorClosed = errors.New("collector: closed")

// Config controls when a batch fires.
type Config struct {
	// MaxBatchSize is the request count that fires a batch.
	MaxBatchSize int
	// MaxWait is the maximum wait after the first request.
	// Zero means only MaxBatchSize can fire the batch.
	MaxWait time.Duration
}

// Collector groups calls to Add into calls to fn.
type Collector struct {
	cfg Config
	fn  BatchFunc
}

// NewCollector returns a Collector with the given config and batch function.
func NewCollector(cfg Config, fn BatchFunc) *Collector {
	return &Collector{cfg: cfg, fn: fn}
}

// Add adds request to the open batch.
// It returns a channel that receives one Result.
func (c *Collector) Add(request int) <-chan Result {
	ch := make(chan Result, 1)

	responses, err := c.fn([]int{request})
	if err != nil {
		ch <- Result{Err: err}
	} else {
		ch <- Result{Value: responses[0]}
	}

	return ch
}

// Close rejects new requests and waits for started batches.
func (c *Collector) Close(ctx context.Context) error {
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

	// Twelve requests make two full batches and one partial batch.
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
