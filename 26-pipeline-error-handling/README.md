# Pipeline Error Handling: Result Values Instead of Aborting

`ProcessReadings` runs a small two-stage pipeline. It takes raw sensor
strings and parses each one with `parse`. Then it checks each value with
`reciprocal`.

A reading can fail in two ways. It may not be an integer, or it may be
`0`. `reciprocal` cannot handle `0`.

Today, one bad reading stops the whole batch. The stage returns early
and closes its output. Every later reading is skipped. The caller then
cannot tell which reading failed or what came after it.

```
TODAY - 8 readings in, 1 result out

readings []string: "10" "abc" "5" "0" "-3" "xyz" "0" "7"
     │
     ▼
parse (1 goroutine): index 1 "abc" fails Atoi -> return, close(out)
     │               indices 2..7 are never parsed
     ▼  unbuffered chan Result (parse -> reciprocal)
reciprocal (1 goroutine): sees index 0 only, then its input closes
     │
     ▼
ProcessReadings: 1 result for 8 readings

GOAL - 8 readings in, 8 results out, same order

readings []string: "10" "abc" "5" "0" "-3" "xyz" "0" "7"
     │
     ▼
parse (1 goroutine): one Result per reading, never aborts
     │               ok -> Value n, Err nil   bad -> Value 0, Err set
     ▼  unbuffered chan Result (parse -> reciprocal)
reciprocal (1 goroutine): Err != nil -> pass through unchanged
     │                    otherwise Value == 0 -> set ErrDivideByZero
     │                    then keep going on the next Result
     ▼
ProcessReadings: 8 results, in input order
```

Make `parse` and `reciprocal` send errors with values. Use a
`Result{Value, Err}` pair. Do not stop the batch. Do not panic. Only the
caller of `ProcessReadings` should decide how to handle failures.

```go
type Result struct {
	Value int
	Err   error
}
```

- **`parse(done <-chan struct{}, readings []string) <-chan Result`**
  must return one `Result` for every input reading. The order must match
  `readings`. On success, return `Result{Value: n, Err: nil}`. On a parse
  error, return `Result{Value: 0, Err: <non-nil error>}`. Keep processing
  all later readings.

- **`reciprocal(done <-chan struct{}, in <-chan Result) <-chan Result`**
  receives `parse`'s output. If a `Result` already has an error, pass it
  through unchanged. Do not overwrite that error. Do not read a `Value`
  that was never valid. Otherwise, check `Value != 0`. A true reciprocal
  cannot fit in an `int`. So pass `Value` through unchanged. If
  `Value == 0`, set `Err` to `ErrDivideByZero`. Keep processing all later
  `Result` values. The goal is per-item error flow, not the numeric
  transform.

- **`ProcessReadings(done <-chan struct{}, readings []string) []Result`**
  connects `parse -> reciprocal`. Drain the final channel into
  `[]Result`. Return one result per input reading, in input order.

All three functions must respect `done`, as in the other pipeline
exercises.

Keep the `Result` type and all three signatures. Keep the exported
error:

```go
var ErrDivideByZero = errors.New(...)
```

Callers and tests use `errors.Is` to check it.

## Test your solution

The tests must pass:
```
go test
go test --race
```
