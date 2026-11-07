//////////////////////////////////////////////////////////////////////
//
// HandleRequest calls layers A, B, and C in order.
// Each layer takes 300ms and checks its context.
//
// The current code gives every layer context.Background.
// A caller timeout therefore has no effect.
//
// Pass ctx to each layer instead.
//
// Keep this signature:
//
//     func HandleRequest(ctx context.Context) (string, error)
//

package main

import (
	"context"
	"fmt"
	"time"
)

// HandleRequest calls A, B, and C and joins their results.
// It ignores ctx and uses context.Background instead.
func HandleRequest(ctx context.Context) (string, error) {
	a, err := CallLayerA(context.Background())
	if err != nil {
		return "", err
	}

	b, err := CallLayerB(context.Background())
	if err != nil {
		return "", err
	}

	c, err := CallLayerC(context.Background())
	if err != nil {
		return "", err
	}

	return a + b + c, nil
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	result, err := HandleRequest(ctx)
	elapsed := time.Since(start)

	if err != nil {
		fmt.Printf("HandleRequest failed after %s: %v\n", elapsed, err)
		return
	}

	fmt.Printf("HandleRequest succeeded after %s: %q\n", elapsed, result)
}
