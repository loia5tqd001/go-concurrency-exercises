//////////////////////////////////////////////////////////////////////
//
// parse reads integer text.
// reciprocal checks for a value of zero.
// The current pipeline stops at the first bad reading.
// It drops every input after that reading.
//
// Your task is to report errors and keep going:
//   - parse returns one Result for each input, in input order.
//     A failure has Value 0 and a non-nil Err.
//   - reciprocal passes an existing error through unchanged.
//     It sets ErrDivideByZero when a valid Value is 0.
//   - ProcessReadings returns one Result for each input, in input order.
//   - All stages must still stop when done closes.
//
// Keep these signatures:
//
//     func parse(done <-chan struct{}, readings []string) <-chan Result
//     func reciprocal(done <-chan struct{}, in <-chan Result) <-chan Result
//     func ProcessReadings(done <-chan struct{}, readings []string) []Result
//

package main

import (
	"errors"
	"fmt"
	"strconv"
)

// ErrDivideByZero marks a reading whose value is zero.
var ErrDivideByZero = errors.New("cannot compute reciprocal of zero")

// Result carries one value or one error.
type Result struct {
	Value int
	Err   error
}

// parse converts every reading to one Result.
// The current code stops at the first parse error.
func parse(done <-chan struct{}, readings []string) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for _, reading := range readings {
			n, err := strconv.Atoi(reading)
			if err != nil {
				// BUG: stop instead of reporting this reading.
				return
			}

			select {
			case <-done:
				return
			case out <- Result{Value: n}:
			}
		}
	}()
	return out
}

// reciprocal passes errors through and checks valid values.
// The current code stops at the first zero value.
func reciprocal(done <-chan struct{}, in <-chan Result) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for res := range in {
			if res.Value == 0 {
				// BUG: stop instead of reporting this result.
				return
			}

			select {
			case <-done:
				return
			case out <- res:
			}
		}
	}()
	return out
}

// ProcessReadings runs the pipeline and returns one Result per input.
func ProcessReadings(done <-chan struct{}, readings []string) []Result {
	out := reciprocal(done, parse(done, readings))

	results := make([]Result, 0, len(readings))
	for res := range out {
		results = append(results, res)
	}
	return results
}

func main() {
	done := make(chan struct{})
	defer close(done)

	readings := []string{"10", "abc", "5", "0", "-3", "xyz", "0", "7"}

	results := ProcessReadings(done, readings)

	fmt.Printf("got %d results for %d readings\n", len(results), len(readings))
	for i, res := range results {
		fmt.Printf("  [%d] %q -> %+v\n", i, readings[i], res)
	}
}
