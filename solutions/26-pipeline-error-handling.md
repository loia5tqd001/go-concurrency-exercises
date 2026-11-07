# Pipeline Errors: Return Results Instead of Stopping - Suggested Solutions

> **Spoiler warning.** This file has the full solution for `26-pipeline-error-handling/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting code is a two-stage pipeline: `parse -> reciprocal`. `ProcessReadings` connects the stages:

```go
type Result struct {
	Value int
	Err   error
}

func parse(done <-chan struct{}, readings []string) <-chan Result
func reciprocal(done <-chan struct{}, in <-chan Result) <-chan Result
func ProcessReadings(done <-chan struct{}, readings []string) []Result
```

`parse` must convert every reading to an int. It must emit one `Result` per reading, even when that reading fails.

`reciprocal` must pass through a `Result` that already has an error. Otherwise, it checks `Value != 0`. If the value is zero, it sets `Err` to `ErrDivideByZero`.

Both stages must keep processing after a bad item. `ProcessReadings` must return one `Result` for each input, in input order.

## Why the naive version is wrong

Both stages `return` as soon as they find a bad reading. That closes the output channel. They should report the error on one `Result` and continue instead:

```go {8}
func parse(done <-chan struct{}, readings []string) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for _, reading := range readings {
			n, err := strconv.Atoi(reading)
			if err != nil {
				return // BUG: abort the whole batch
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
```

`reciprocal` also returns when it sees `res.Value == 0`. Neither stage sets the `Err` field. A bad reading is not reported. Every later reading disappears.

Verified with the `go1.25.6` toolchain from the repo's `go.mod`. Set `GOROOT` to that toolchain. `go test -v ./...` fails four per-item error tests against the naive `main.go`.

The two `done`-cancellation tests still pass: `TestPipelineStopsPromptlyOnDone` and `TestPipelineNoGoroutineLeakRace`. The bug only affects bad items. The `select` send guard, `select { case <-done: ...; case out <- res: }`, is already correct for good items.

```
=== RUN   TestAllReadingsProduceResults
    check_test.go:60: ProcessReadings(8 readings) returned 1 results, want 8 - looks like the pipeline aborted early instead of reporting each bad reading and continuing
--- FAIL: TestAllReadingsProduceResults (0.00s)
=== RUN   TestGoodReadingsSucceed
    check_test.go:77: no result for reading 2 ("5"): pipeline aborted early instead of reporting the error and continuing
--- FAIL: TestGoodReadingsSucceed (0.00s)
=== RUN   TestBadReadingsCarryErrors
    check_test.go:101: no result for reading 1 ("abc"): pipeline aborted early instead of reporting the error and continuing
--- FAIL: TestBadReadingsCarryErrors (0.00s)
=== RUN   TestProcessingContinuesPastBadReadings
    check_test.go:145: no result for reading 2 ("5"), which comes after a bad reading: the pipeline stopped processing instead of continuing past the error
--- FAIL: TestProcessingContinuesPastBadReadings (0.00s)
=== RUN   TestPipelineStopsPromptlyOnDone
--- PASS: TestPipelineStopsPromptlyOnDone (0.02s)
=== RUN   TestPipelineNoGoroutineLeakRace
--- PASS: TestPipelineNoGoroutineLeakRace (0.21s)
FAIL
```

`TestBadReadingsCarryErrors` loops over the `parseErrIndex` and `divZeroIndex` maps. Go map order changes between runs. The first reported index can therefore change. The outcome and message format stay the same.

`check_test.go` includes `TestProcessingContinuesPastBadReadings`. That test checks the main fix.

The input is `readings := []string{"10", "abc", "5", "0", "-3", "xyz", "0", "7"}`. The `readings` slice has eight values. `parse` converts `"10"`, then hits `"abc"` at index 1 and stops. `reciprocal` never sees indices 2 through 7. `go run .` prints `got 1 results for 8 readings`.

## Approach: emit a `Result` for every item, keep the loop running

The fix removes each failure-path `return`. Each stage builds the right `Result`, then continues:

```go {30-35,56}
package main

import (
	"errors"
	"fmt"
	"strconv"
)

// ErrDivideByZero is the sentinel error reciprocal sets on a Result
// whose Value is 0.
var ErrDivideByZero = errors.New("cannot compute reciprocal of zero")

// Result carries either a successfully processed Value (with Err ==
// nil) or a failure (with Err != nil, in which case Value should be
// ignored).
type Result struct {
	Value int
	Err   error
}

// parse converts every reading to an int, emitting one Result per
// reading - success or failure - without ever stopping early.
func parse(done <-chan struct{}, readings []string) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for _, reading := range readings {
			n, err := strconv.Atoi(reading)

			var res Result
			if err != nil {
				res = Result{Value: 0, Err: fmt.Errorf("invalid reading %q: %w", reading, err)}
			} else {
				res = Result{Value: n}
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

// reciprocal passes through any Result that already carries an error
// unchanged, and otherwise validates Value != 0, setting Err to
// ErrDivideByZero when it is. It keeps processing every remaining
// Result regardless of what it just saw.
func reciprocal(done <-chan struct{}, in <-chan Result) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for res := range in {
			if res.Err == nil && res.Value == 0 {
				res.Err = ErrDivideByZero
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

// ProcessReadings runs readings through the parse -> reciprocal
// pipeline and drains the result into a slice, one Result per input
// reading, in the same order as readings.
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
```

Design notes:

- **Keep `Value` and `Err` in one `Result{Value, Err}` on one channel.** A second `<-chan error` would split one fact across two channels. The consumer would have to match values and errors.
- **Do not return one batch-level `error`.** That only says "some item failed." It does not name the bad item. It does not say how many items passed.
- **Do not return from either loop for a bad item.** The loops are `for _, reading := range readings` and `for res := range in`. Return only when `<-done` fires. Each good iteration sends one `Result`. A closed `done` stops both stages on purpose.
- **The output count must match the input count.** The target is `len(results) == len(readings)`.
- **Check `res.Err == nil && res.Value == 0`.** A parse failure also leaves `Value == 0`. Check `res.Value == 0` only when `Err` is `nil`. Checking only `Value` would replace the parse error with `ErrDivideByZero`.
- **A parse failure uses `0` as its default.** It must keep its real error.
- **Use the local `res` copy.** Change that copy and send it again. This keeps one send path instead of two almost identical branches.
- **Fix both stages.** The supplied input makes `parse` stop before `reciprocal` reaches a zero value. Fixing only `parse` still produces one result. Both stages need the same change.
- **Wrap errors with `%w`.** A caller can then use `errors.Is` or `errors.As` to find the original `*strconv.NumError`. The exercise only checks `Err != nil`.
- **Do not use `panic` or `log.Fatal` for one bad item.** Send a failed `Result` and continue.
- **Keep the pipeline shape.** It already has one goroutine per stage and an unbuffered channel. Both stages honor `done` on receive and send. The bug is how they treat a bad item, not the concurrency setup.

**Verified:** The naive `main.go` passes `go build .`, `go vet .`, and `gofmt -l .`.
The fix passes `go build ./...`, `go vet ./...`, and `go test -race -count=5 ./...`.
All six tests passed every time.

The cancellation tests block both stages while sending. No receiver drains the output before `done` closes. Removing `case <-done:` would hang or run the whole batch. A timeout makes that failure return instead of hanging forever.

The naive version still builds. It passes `go vet` and `gofmt`. It fails only the four error tests. The exercise must compile before a learner starts.

## Key takeaways

- A bad item should not cancel the whole batch. Send an error value on the same channel. Let the caller decide what to do.
- `done` and a bad item mean different things. `done` means stop now. A bad item means report this item and continue.
- Check an upstream error before checking zero values. A parse failure may also use zero as its default value.
- Always return one `Result` per input. Otherwise, the caller cannot tell a failure from a missing item.
