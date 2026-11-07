# Sharded Cache: Reducing Lock Contention - Suggested Solutions

> **Spoiler warning.** This file has full solutions for `23-sharded-cache/`. Try the exercise first. Come back if you are stuck or want to compare approaches.

## The problem

The starting `Cache` is race-free. One mutex protects one map. The result is still bad: calls block each other too often.

```go {7,8,11}
type Cache struct {
	mu   sync.Mutex
	data map[string]int
}

func (c *Cache) Do(key string, work func(cur int) int) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	cur := c.data[key]
	next := work(cur)
	c.data[key] = next
	return next
}
```

The lock stays held for the *entire* call to `work`. A slow call for key `"a"` therefore blocks a fast call for key `"b"`. The two keys do not conflict, but they still wait for each other.

Make `Cache` use `N` independent shards, such as `const numShards = 16`. Each shard needs its own mutex and map. Keys in different shards can then run in parallel. Calls for the *same* key stay serialized.

The exercise fixes the shard function so the tests can rely on it:

```go
shardIndex := int(key[0]) % numShards
```

Keep these signatures: `func NewCache() *Cache` and `func (c *Cache) Do(key string, work func(cur int) int) int`.

## Why the naive version is wrong

There is no data race. That is the trap. The single `sync.Mutex` makes every `Do` call safe under `-race`. If you only check for races, the design looks correct.

The bug is a **performance** bug. The lock covers too much code. It covers `work`, not just the map read and write. Calls for unrelated keys still run one after another.

Verified: the naive `main.go` fails only the contention test:

```
--- FAIL: TestCacheDifferentKeysDontBlockEachOther (0.20s)
    check_test.go:162: cache.Do(keyB, ...) took 180.410208ms, want < 50ms - keyA and keyB
    are in different shards and must not block each other, but this call appears to have
    waited behind keyA's 200ms lock hold
FAIL
```

`TestCacheCorrectness` and `TestCacheSameKeySerializesCorrectly` still pass. One global mutex is correct. It only adds needless waiting.

`TestCacheDifferentKeysDontBlockEachOther` uses the real clock by design. In Go 1.25, `testing/synctest` does not count a blocked `sync.Mutex.Lock()` as a blocking wait.

Inside `synctest.Test`, the fake clock would run forever. It would not see the blocked `Lock()`. The test would hang against the naive version instead of failing.

`synctest` tracks channels, `context.Done()`, `time.Sleep`, and some other standard-library operations. It does not track a goroutine waiting inside `sync.Mutex.Lock()`. A test that proves mutex blocking must therefore use the real clock. It also needs a wide margin. This test uses `slowWork` at 4x the pass/fail `budget`.

## Approach 1: fixed sharding by first byte

```go {50,59,61}
package main

import (
	"fmt"
	"sync"
	"time"
)

const numShards = 16

type shard struct {
	mu   sync.Mutex
	data map[string]int
}

// Cache is a key-value store sharded into numShards independent
// shards, each guarded by its own mutex, so operations on keys in
// different shards can proceed with true parallelism while operations
// on the same key remain correctly serialized through that key's
// shard lock.
type Cache struct {
	shards [numShards]*shard
}

// NewCache creates an empty Cache.
func NewCache() *Cache {
	c := &Cache{}
	for i := range c.shards {
		c.shards[i] = &shard{data: make(map[string]int)}
	}
	return c
}

// shardFor picks the shard responsible for key, using the key's first
// byte mod numShards. Empty keys are not expected by this exercise,
// but are mapped to shard 0 rather than panicking.
func (c *Cache) shardFor(key string) *shard {
	if len(key) == 0 {
		return c.shards[0]
	}
	idx := int(key[0]) % numShards
	return c.shards[idx]
}

// Do reads the current value stored at key (0 if absent), passes it
// to work, stores whatever work returns back at key, and returns that
// new value - all while holding only key's shard's lock, so
// operations on keys in other shards are never blocked by this call.
func (c *Cache) Do(key string, work func(cur int) int) int {
	s := c.shardFor(key)

	s.mu.Lock()
	defer s.mu.Unlock()

	cur := s.data[key]
	next := work(cur)
	s.data[key] = next
	return next
}

func main() {
	cache := NewCache()

	var wg sync.WaitGroup
	wg.Add(1)

	go func() {
		defer wg.Done()

		cache.Do("a", func(cur int) int {
			time.Sleep(200 * time.Millisecond)
			return cur + 1
		})
	}()

	time.Sleep(10 * time.Millisecond)

	start := time.Now()
	cache.Do("b", func(cur int) int { return cur + 1 })
	elapsed := time.Since(start)

	fmt.Printf("Do(\"b\", ...) took %s\n", elapsed)
	fmt.Println("(with sharded locks, this returns almost immediately regardless of \"a\"'s slow work)")

	wg.Wait()
}
```

Design notes:

- **The test keeps its own `referenceNumShards` constant.** This avoids a same-package name collision. Solvers can still use the natural `numShards` name.
- **`shardFor` uses the exact formula from the exercise:** `int(key[0]) % 16`. The test runs from `check_test.go`. The variables `keyA` and `keyB` use known first bytes.
- **The test sets `keyA = "apple-key"` and `keyB = "banana-key"`.** The variables `keyA` and `keyB` therefore have known first bytes.
- **The test keys map to different shards.** The first byte `'a'` is 97, and `97 % 16 = 1`. The first byte `'b'` is 98, and `98 % 16 = 2`.
- **The test checks that mapping.** Its `init()` panics if both keys map to the same shard. A solution must use first-byte mod 16, or match it for these keys.
- **Each shard owns its mutex and map.** The type is `type shard struct { mu sync.Mutex; data map[string]int }`. Per-key locks do not share one map. Locking shard `i` is enough to read or write any key in shard `i`.
- **`Do` uses the same critical section as the naive version:** lock, read, call `work`, write, unlock. The lock now covers one shard, not the whole cache. `work` still runs under the lock, which same-key serialization requires.
- **A fixed shard count uses fixed memory.** `NewCache` creates exactly 16 mutex and map pairs. The number of keys does not change that.

**Verified:** The naive `main.go` fails `TestCacheDifferentKeysDontBlockEachOther`. The other two tests pass. This solution passes `go test -race -count=1 ./...` five times in a row. The runs include the real-clock contention test and the 50-goroutine same-key test under `-race`.

## Approach 2: per-key locks via `sync.Map` (alternative)

This version uses a different structure. It does not split keys into fixed shards. It gives each distinct key one `*sync.Mutex`. `sync.Map.LoadOrStore` creates that mutex lazily and atomically.

```go {37,40}
package main

import (
	"fmt"
	"sync"
	"time"
)

// Cache is a key-value store that hands out one *sync.Mutex per
// distinct key (created lazily, atomically, via sync.Map.LoadOrStore)
// instead of pre-splitting into a fixed number of shards. Two
// different keys always get two different mutexes, so they can never
// block each other; the same key always maps to the same mutex, so
// operations on it stay correctly serialized.
type Cache struct {
	locks sync.Map // key (string) -> *sync.Mutex
	data  sync.Map // key (string) -> int
}

// NewCache creates an empty Cache.
func NewCache() *Cache {
	return &Cache{}
}

// Do reads the current value stored at key (0 if absent), passes it
// to work, stores whatever work returns back at key, and returns that
// new value - all while holding only key's own mutex, so operations
// on any other key are never blocked by this call.
func (c *Cache) Do(key string, work func(cur int) int) int {
	// sync.Map itself does NOT serialize "read, compute, write" for a
	// given key - two concurrent Do calls on the same key could both
	// Load the old value before either Store'd the new one, silently
	// losing an update. LoadOrStore is only used here to atomically
	// get-or-create that key's own *sync.Mutex; the mutex is what
	// actually provides the same-key serialization the exercise
	// requires - sync.Map on its own would not be enough.
	lockIface, _ := c.locks.LoadOrStore(key, &sync.Mutex{})
	lock := lockIface.(*sync.Mutex)

	lock.Lock()
	defer lock.Unlock()

	cur := 0
	if v, ok := c.data.Load(key); ok {
		cur = v.(int)
	}
	next := work(cur)
	c.data.Store(key, next)
	return next
}

func main() {
	cache := NewCache()

	var wg sync.WaitGroup
	wg.Add(1)

	go func() {
		defer wg.Done()

		cache.Do("a", func(cur int) int {
			time.Sleep(200 * time.Millisecond)
			return cur + 1
		})
	}()

	time.Sleep(10 * time.Millisecond)

	start := time.Now()
	cache.Do("b", func(cur int) int { return cur + 1 })
	elapsed := time.Since(start)

	fmt.Printf("Do(\"b\", ...) took %s\n", elapsed)
	fmt.Println("(with per-key locks, this returns almost immediately regardless of \"a\"'s slow work)")

	wg.Wait()
}
```

Design notes and differences from Approach 1:

- **`sync.Map` alone does not solve the slow-work problem.** The per-key mutex does. `sync.Map` only makes each `Load`, `Store`, or `LoadOrStore` call atomic. It does not make a whole read-modify-write sequence atomic. Two `Do("shared-key", ...)` calls could read the same value and lose one update. `TestCacheSameKeySerializesCorrectly` catches that bug. Here, `sync.Map` only creates each key's `*sync.Mutex`. The mutex does the serialization.
- **This design has more locks than 16 fixed shards.** Every different key always gets a different mutex. `TestCacheDifferentKeysDontBlockEachOther` passes for a stronger reason. It does not rely on the first-byte formula.
- **The cost is permanent, unbounded memory growth.** Every key used by `Do` keeps a `*sync.Mutex` entry in `locks` forever. Nothing evicts it. A cache with millions of keys keeps millions of mutex entries. Those entries stay even after their values stop mattering. Approach 1 uses fixed memory because it has 16 shards. Per-key locks allow more concurrency but can grow without limit.
- **`sync.Map` targets a different access pattern.** It works best with one write and many reads. It also helps when goroutines use separate key sets. A cache that constantly creates keys does not fit well. `sync.Map` is still correct, but not a clear win.

**Verified:** `go build ./...` is clean. `go test -race -count=1 ./...` passes five times in a row. The runs cover all three tests.

## Key takeaways

- A race-free mutex can still cause a serious performance bug. Its scope may be too broad. `-race` will not flag a lock held for too long. Use a timing test such as `TestCacheDifferentKeysDontBlockEachOther`.
- A fixed shard function makes blocking behavior testable. Use `int(key[0]) % numShards`. Pick keys with known shard numbers. Do not depend on luck.
- Atomic map operations are not the same as an atomic read-modify-write sequence. `sync.Map` alone does not serialize calls for the same key. Use a per-key or per-shard mutex.
- Per-key locks reduce contention. They also grow memory with every new key because nothing evicts the locks.
- `testing/synctest` only counts a fixed set of operations as blocking waits. These include channels, `context.Done()`, and `time.Sleep`. A blocked `sync.Mutex.Lock()` is not included. Use the real clock with a wide margin when testing mutex blocking.
