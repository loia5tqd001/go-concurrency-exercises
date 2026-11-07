# Concurrent Map-Reduce: Parallel Word Count

Given is a function `WordCount` that is supposed to count word
occurrences across many text chunks, using the map-reduce pattern: a
"map" phase that processes each chunk independently and concurrently
into its own partial count, and a "reduce" phase that merges all the
partials into one final result - all without multiple goroutines ever
writing to the same shared map at the same time (which would race).
The current implementation instead processes chunks sequentially, one
at a time, merging each chunk's words directly into a single shared
result map as it goes - which is correct, but leaves all the
chunk-level parallelism on the table, since chunk 2 can't even start
being tokenized until chunk 1's tokenizing (simulated by
`time.Sleep(ProcessDelay)` per chunk) has fully finished.

```
today: 1 goroutine, 10 chunks x 30ms each            ~300ms wall clock
  chunk0 ─30ms─▶ chunk1 ─30ms─▶ ... ─▶ chunk9 ─30ms─▶ result map

goal: 10 map goroutines, then 1 reduce goroutine       ~30ms wall clock
  chunk0 ─30ms─▶ local map0 ─┐
  chunk1 ─30ms─▶ local map1 ─┤
     ...                     ├─▶ reduce (1 goroutine) ──▶ result map
  chunk9 ─30ms─▶ local map9 ─┘
```

Your task is to reimplement `WordCount` as true map-reduce. Chunk work
must overlap, and the map phase must not mutate one shared result map
concurrently. The reduce phase starts only after every map result is
available, then merges those results without racing the final map.
Keep the signature the same:

```go
func WordCount(chunks []string) map[string]int
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
