# Concurrent map-reduce: parallel word count

> **Spoiler warning.** This file has full solutions for `20-concurrent-map-reduce/`. Try the exercise first. Come back if you get stuck.

## The problem

`WordCount` counts words across many text chunks. It uses the map-reduce pattern.

The map phase splits each chunk into words. It runs chunks at the same time. The reduce phase merges the partial counts.

Two goroutines must never write to the same map at the same time. The starter handles chunks one at a time. It merges each chunk into one `result` map:

```go
func WordCount(chunks []string) map[string]int {
	result := make(map[string]int)

	for _, chunk := range chunks {
		time.Sleep(ProcessDelay)
		for _, word := range strings.Fields(chunk) {
			result[word]++
		}
	}

	return result
}
```

This code is correct. Only one goroutine touches `result`.

Chunk 2 cannot start until chunk 1 finishes `time.Sleep(ProcessDelay)`. Ten chunks take ten sleeps. Splitting one chunk does not depend on another.

## Why the naive version is wrong

This is a throughput bug, not a correctness bug. The sequential loop always passes `TestWordCountCorrectness`. It drops no words, counts nothing twice, and cannot race on `result`.

It fails `TestWordCountConcurrency`. That test uses `synctest.Test` and a fake clock. It requires the call to finish well under 100ms.

Ten chunks at 30ms each take 300ms in sequence. The test reports that time:

```
--- FAIL: TestWordCountConcurrency (0.00s)
    check_test.go:126: WordCount took 300ms (sequential would take 300ms); want
    well under 100ms - looks like chunks are being processed one at a time
    instead of concurrently
```

The fake clock is the right tool here. The naive code is slow, not stuck.

The clock moves forward when every goroutine is blocked. It measures the delay exactly, even on a busy machine.

Exercise 21 has a real deadlock. `synctest` is the wrong tool there. Its solution doc explains why.

## Approach 1: Goroutine-per-chunk into local maps, merge once (map-reduce, as specified)

This is the design the exercise asks for. Each chunk gets its own goroutine.

Each goroutine writes to its own local `map[string]int`. The map phase uses no shared mutable state. One sequential reduce step runs after every goroutine finishes.

```go {13,17}
func WordCount(chunks []string) map[string]int {
	partials := make([]map[string]int, len(chunks))

	var wg sync.WaitGroup
	for i, chunk := range chunks {
		wg.Go(func() {
			time.Sleep(ProcessDelay)

			local := make(map[string]int)
			for _, word := range strings.Fields(chunk) {
				local[word]++
			}
			partials[i] = local
		})
	}

	wg.Wait()

	result := make(map[string]int)
	for _, partial := range partials {
		for word, count := range partial {
			result[word] += count
		}
	}

	return result
}
```

Here is why this has no race:

- Map phase: each goroutine owns one slot, `partials[i]`. No other goroutine touches it.
- It also builds a new `local` map. No other goroutine has a reference to that map.
- The only shared write is `partials[i] = local`. Each `i` belongs to one goroutine.
- Go allows concurrent writes to different slice indices. They do not overlap.
- You do not need to recapture `i` and `chunk`. Since Go 1.22, each `for` loop has its own variables.
- The old shadowing trick was `i, chunk := i, chunk`. It is no longer needed here.
- Reduce phase: `wg.Wait()` creates a happens-before edge before the reduce loop.
- Every `partials` entry is complete and visible when the loop runs. One goroutine runs the reduce, so `result` needs no lock.
- `wg.Go(func() { ... })` arrived in Go 1.24. It replaces `wg.Add(1)` and `defer wg.Done()`.
- No manual `Done()` call is needed, so you cannot forget it.

This version passed `go test -race -count=3` in a scratch copy with no flakes. The tests ran in about 0.03s to 0.16s.

`TestWordCountCorrectness`, `TestWordCountConcurrency`, and `TestWordCountRace` all passed. `TestWordCountRace` runs `WordCount` five times over 30 chunks. The race detector reported nothing.

## Approach 1b (alternative): channel-of-partials fan-in instead of an indexed slice

The exercise also accepts "fanning the partials in over a channel of maps." This works.

It adds one moving part. You need a `chan map[string]int` and a goroutine that closes it after every map goroutine finishes. The reduce `range` then knows when to stop.

```go {13,18}
func WordCount(chunks []string) map[string]int {
	var wg sync.WaitGroup
	resultCh := make(chan map[string]int)

	for _, chunk := range chunks {
		wg.Go(func() {
			time.Sleep(ProcessDelay)

			local := make(map[string]int)
			for _, word := range strings.Fields(chunk) {
				local[word]++
			}
			resultCh <- local
		})
	}
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	result := make(map[string]int)
	for partial := range resultCh {
		for word, count := range partial {
			result[word] += count
		}
	}

	return result
}
```

This version has no race, just like Approach 1. No goroutine writes a map that another goroutine owns. It also passed `go test -race -count=3`.

Use it when you do not know the partial count upfront. Use it when the reduce side should start before every map finishes.

Neither case applies here. The chunk count is known before the loop. The reduce waits for every partial anyway.

Approach 1 is the better default for this exercise. It has no channel and no closer goroutine.

## Common mistake to avoid: goroutine-per-chunk writing into ONE shared map

A common wrong fix starts one goroutine per chunk. This passes `TestWordCountConcurrency`.

It skips local maps. Every goroutine writes to the same shared `result` map:

```go {13}
func WordCount(chunks []string) map[string]int {
	result := make(map[string]int)

	var wg sync.WaitGroup
	wg.Add(len(chunks))

	for _, chunk := range chunks {
		chunk := chunk
		go func() {
			defer wg.Done()
			time.Sleep(ProcessDelay)
			for _, word := range strings.Fields(chunk) {
				result[word]++ // shared map, no lock - racy
			}
		}()
	}

	wg.Wait()
	return result
}
```

This code looks like it should work. Small inputs can appear to work for several runs.

`result[word]++` is a read-modify-write. Go's map code does not always corrupt itself when two goroutines touch it.

The code still has a real data race. Go treats that race as undefined behavior even when a run looks fine.

I tested both cases in a scratch copy. I ran `go test -run TestWordCountRace -count=1` without `-race` eight times. It passed every time.

Then I ran it with `-race`. It failed every time. First it printed data-race warnings, then a fatal runtime error:

```
==================
WARNING: DATA RACE
Read at 0x00c0001806c0 by goroutine 36:
  runtime.mapdelete_fast64()
      .../internal/runtime/maps/runtime_fast64_swiss.go:502 +0x8c
  verify20.WordCount.func1()
      main.go:33 +0xe0

Previous write at 0x00c0001806c0 by goroutine 14:
  runtime.mapaccess2_faststr()
      .../internal/runtime/maps/runtime_faststr_swiss.go:162 +0x29c
  verify20.WordCount.func1()
      main.go:33 +0x10c
==================
fatal error: concurrent map writes
```

`fatal error: concurrent map writes` comes from Go's runtime map guard. It is not the race detector.

The guard fires when two writers leave the map's internal state inconsistent. The timing must be unlucky. Plain `go test` can run this code all day and see nothing.

`-race` detects the race without waiting for corruption. It tracks memory access and happens-before data.

It needs two unprotected accesses to the same memory, and one must be a write. Every `-race` run failed here.

This is why `TestWordCountRace` exists. It is also why the instructions say to run `go test --race`. A bug can hide under plain `go test` and still reach production.

The rule is simple. Never use a shared map without synchronizing access.

Approach 1 shares no mutable map. Approach 2 shares one and protects each part.

## Approach 2 (alternative, real-world contrast): sharded map with per-shard locks

This approach does not satisfy the exercise. The comments and `README.md` require no shared mutable state in the map phase.

Each goroutine must build its own local `map[string]int`. This design writes into one shared structure. It has the same shape as the common mistake above.

The design is still worth knowing. It shows the real rule: the mistake was unsynchronized map access, not sharing itself.

A shared map is safe when every access to a key is serialized with every other access to that key. Sharding does that.

```go {23,28}
const numShards = 16

type shard struct {
	mu     sync.Mutex
	counts map[string]int
}

type shardedMap struct {
	shards [numShards]*shard
}

func newShardedMap() *shardedMap {
	sm := &shardedMap{}
	for i := range sm.shards {
		sm.shards[i] = &shard{counts: make(map[string]int)}
	}
	return sm
}

func (sm *shardedMap) shardFor(word string) *shard {
	h := fnv.New32a()
	h.Write([]byte(word))
	return sm.shards[h.Sum32()%numShards]
}

func (sm *shardedMap) add(word string, n int) {
	s := sm.shardFor(word)
	s.mu.Lock()
	s.counts[word] += n
	s.mu.Unlock()
}

func (sm *shardedMap) merge() map[string]int {
	result := make(map[string]int)
	for _, s := range sm.shards {
		s.mu.Lock()
		for word, count := range s.counts {
			result[word] += count
		}
		s.mu.Unlock()
	}
	return result
}

func WordCount(chunks []string) map[string]int {
	sm := newShardedMap()

	var wg sync.WaitGroup
	wg.Add(len(chunks))

	for _, chunk := range chunks {
		chunk := chunk
		go func() {
			defer wg.Done()
			time.Sleep(ProcessDelay)
			for _, word := range strings.Fields(chunk) {
				sm.add(word, 1)
			}
		}()
	}

	wg.Wait()
	return sm.merge()
}
```

The map uses a hash from word to shard index. It splits across `numShards` independent mutexes.

Writes to different shards do not contend. Writes to the same word use the same shard lock. No global lock is needed.

This version passed `go test -race -count=3` in a scratch copy. Its timings matched Approach 1.

Use this design when `len(chunks)` full copies are too large for memory. One example is many chunks with many unique keys.

Use it when writers need to update one structure as they go. This fits a long-lived counter or cache, not a one-shot batch.

This exercise uses ten to thirty small chunks and one batch call. Approach 1 is simpler, cheaper, and the intended design.

## Key takeaways

- The naive version is slow, not wrong. It drops no words and counts none twice.
- It passes `TestWordCountCorrectness` and fails `TestWordCountConcurrency`.
- The concurrency test uses `synctest.Test` to measure fake-clock time.
- Starting one goroutine per chunk fixes only the speed test.
- If those goroutines share one map with no protection, the code has a data race.
- Plain `go test` can hide that race for many runs. It is still undefined behavior.
- Use `go test --race`. `TestWordCountRace` is the stress test for this case.
- Do not touch shared mutable state without synchronization. Do not ban shared maps.
- Approach 1 uses local maps and one reduce pass. Approach 2 shares a map with per-key locks.
- Approach 2 is a real-world option, but this exercise does not ask for it.
- `sync.WaitGroup.Wait()` creates the happens-before edge before the reduce loop.
- That edge makes the reduce reads safe. The map itself does not provide it.
