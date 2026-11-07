# Concurrent Map-Reduce: Parallel Word Count

`WordCount` counts words across many text chunks. It uses map-reduce.
The map phase counts each chunk on its own. The reduce phase merges all
the counts. Two goroutines must never write to the same map at the same
time.

Today, `WordCount` handles chunks one at a time. It puts every chunk's
words into one shared map. The result is correct. But the chunks cannot
run together. Each chunk also waits for `time.Sleep(ProcessDelay)`
before the next chunk starts.

```
today: 1 goroutine, 10 chunks x 30ms each            ~300ms wall clock
  chunk0 ─30ms─▶ chunk1 ─30ms─▶ ... ─▶ chunk9 ─30ms─▶ result map

goal: 10 map goroutines, then 1 reduce goroutine       ~30ms wall clock
  chunk0 ─30ms─▶ local map0 ─┐
  chunk1 ─30ms─▶ local map1 ─┤
     ...                     ├─▶ reduce (1 goroutine) ──▶ result map
  chunk9 ─30ms─▶ local map9 ─┘
```

Your task is to make `WordCount` use true map-reduce. Chunk work must
overlap. Each map must use its own result. The reduce phase starts after
all maps finish. It then merges the maps without a race. Keep the
signature the same:

```go
func WordCount(chunks []string) map[string]int
```

## Test your solution

The tests must pass:

```
go test
go test --race
```
