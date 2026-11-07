# Race Condition in Caching Scenario — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `02-race-in-cache/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`KeyStoreCache` is an LRU cache. It uses a `map[string]*list.Element` for
O(1) lookup and a `container/list.List` for recency order. `Get` does
this:

1. Look up `key` in `cache`. On a hit, move the element to the front of `pages` (most-recently-used) and return its value.
2. On a miss, load the value from the database. If the cache is full
   (`CacheSize == 100`), evict the least-recently-used entry. Then push
   the new entry onto both `pages` and `cache`.

The test harness (`mockserver.go`) starts `15 * 100 = 1500` goroutines. It
uses only 100 keys, from `"Test0"` to `"Test99"`. `CacheSize == 100`, so a
correct `TestMain` should not evict any key. `check_test.go` also requires
each key to load at most once. `db.Calls` must stay within
`callsPerCycle == 100`.

## Why the naive version is wrong

Nothing protects `cache` or `pages`. Many goroutines can change both:

- **The map.** One goroutine writes `cache[key] = ...`. Another reads
  `cache[key]`. A plain map read at the same time as a write is undefined
  in Go. It is not just a write-versus-write problem.
  `go test -race -run TestMain` shows this:

  ```
  WARNING: DATA RACE
  Write at 0x00c000096690 by goroutine 316:
    runtime.mapaccess2_faststr()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:63   (the `k.cache[key] = k.pages.Front()` on a miss path)

  Previous read at 0x00c000096690 by goroutine 1117:
    runtime.mapaccess1_faststr()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:48   (the `if e, ok := k.cache[key]; ok` hit check, from another goroutine)
  ```

  Without `-race`, it can crash:
  `fatal error: concurrent map writes`.

- **The list.** This part is easy to miss. `container/list.List` has no
  lock. `MoveToFront` changes the list even though it looks like a read.
  A miss calls `PushFront`. It can race with `PushFront`, `MoveToFront`,
  or `Remove` from another goroutine. `TestMain` also shows this:

  ```
  WARNING: DATA RACE
  Read at 0x00c000092948 by goroutine 187:
    container/list.(*List).lazyInit()
    container/list.(*List).PushFront()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:62

  Previous write at 0x00c000092948 by goroutine 316:
    container/list.(*List).Init()
    container/list.(*List).lazyInit()
    container/list.(*List).PushFront()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:62
  ```

  This shows two misses racing on `PushFront`. `sync.Map` cannot fix this.
  It protects a map, but the LRU order stays in `container/list.List`.
  That list needs its own lock.

  Do not use `RWMutex` with only `RLock` on a hit. A hit calls
  `MoveToFront`, which writes. `TestConcurrentHits` catches this. It sends
  many hits to a few cached keys, so `MoveToFront` collides with itself.
  This is the result:

  ```
  WARNING: DATA RACE
  Read at 0x00c00010e2c0 by goroutine 11:
    container/list.(*List).MoveToFront()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:36 in this throwaway RWMutex variant (MoveToFront called while only holding RLock)

  Previous write at 0x00c00010e2c0 by goroutine 9:
    container/list.(*List).move()
    container/list.(*List).MoveToFront()
    github.com/loia5tqd001/go-concurrency-exercises/02-race-in-cache.(*KeyStoreCache).Get()
        main.go:36 (the other concurrent RLock holder)
  ```

  Two goroutines can hold `RLock()` together. That is what `RWMutex` does.
  But both also call `MoveToFront`, which writes, so they race.

  `TestMain` and `TestLRU` alone pass this version 5/5. Each distinct key
  mostly moves once, so the same node is rarely touched twice. These
  commands show both results:
  `go test -race -count=5 -run 'TestMain|TestLRU'` and
  `go test -race -count=5 -run TestConcurrentHits`.

  The second test fails 5/5. Each run has many `WARNING: DATA RACE`
  blocks. Its repeated hits on a few keys make the collision reliable.

A second rule is easy to miss. `db.Calls` must not exceed 100. Suppose you
lock only the map and list. You release the lock during `k.load(key)`.
This can be race-free. But many goroutines can miss the same key before
the first load ends. Each goroutine then calls the database. A test run
shows:

```
check_test.go:33: Incorrect cache size 99
check_test.go:36: Incorrect pages size 1490
check_test.go:39: Too much db uses 1500
```

Every call reloads from the database. Duplicate misses also add many list
elements for one key. The map keeps only the last one. The two structures
then hold different counts.

The full check, load, and insert sequence for one key must act as one
step. Protecting only the map and list changes is not enough.

## Approach 1: single mutex around the whole critical section

The simplest fix uses one `sync.Mutex`. It protects all of `Get`,
including `k.load(key)`. This stops two goroutines from loading the same
key. The cost is that all cache access runs one call at a time.

```go {22,38,39}
package main

import (
	"container/list"
	"sync"
)

// CacheSize determines how big the cache can grow
const CacheSize = 100

type KeyStoreCacheLoader interface {
	Load(string) string
}

type page struct {
	Key   string
	Value string
}

// KeyStoreCache is a LRU cache for string key-value pairs
type KeyStoreCache struct {
	mu    sync.Mutex
	cache map[string]*list.Element
	pages list.List
	load  func(string) string
}

// New creates a new KeyStoreCache
func New(load KeyStoreCacheLoader) *KeyStoreCache {
	return &KeyStoreCache{
		load:  load.Load,
		cache: make(map[string]*list.Element),
	}
}

// Get gets the key from cache, loads it from the source if needed
func (k *KeyStoreCache) Get(key string) string {
	k.mu.Lock()
	defer k.mu.Unlock()

	if e, ok := k.cache[key]; ok {
		k.pages.MoveToFront(e)
		return e.Value.(page).Value
	}
	// Miss - load from database and save it in cache
	p := page{key, k.load(key)}
	// if cache is full remove the least used item
	if len(k.cache) >= CacheSize {
		end := k.pages.Back()
		delete(k.cache, end.Value.(page).Key)
		k.pages.Remove(end)
	}
	k.pages.PushFront(p)
	k.cache[key] = k.pages.Front()
	return p.Value
}
```

**Verified:** `go vet ./...` is clean. `go test -race -count=5 ./...`
passes 5/5 with correct results from `TestMain`, `TestLRU`, and
`TestConcurrentHits`.

The lock is held during `k.load`. Every miss waits for every other miss
and hit. Total time is about `(number of distinct keys) × (DB latency)`.
Here that is `100 keys × 20ms ≈ 2s` per `TestMain` run.

Under `-race` on go1.25.6/darwin-arm64, each run measured about
2.16–2.20s. `TestMain` and `TestLRU` took about 4.3s together. This
passes the README's 30s and 5s limits. The margin is thin. More keys or a
slower database will make this lock the bottleneck.

## Approach 2: per-key load deduplication ("singleflight"), lock released during the DB call

This design keeps the mutex small. It protects only map and list changes.
It releases the lock during the database load. Different keys can then
load at the same time.

Each key can load only once. Track running loads per key. If a key is
already loading, another caller waits for that load. This is the same
idea as `golang.org/x/sync/singleflight`, written by hand.

```go {34,55,59,63,64,68,82}
package main

import (
	"container/list"
	"sync"
)

// CacheSize determines how big the cache can grow
const CacheSize = 100

type KeyStoreCacheLoader interface {
	Load(string) string
}

type page struct {
	Key   string
	Value string
}

// call represents an in-flight (or just-completed) load for a single key,
// so concurrent misses on the same key share one DB call instead of each
// triggering its own ("thundering herd" / dogpile problem).
type call struct {
	done  chan struct{}
	value string
}

// KeyStoreCache is a LRU cache for string key-value pairs
type KeyStoreCache struct {
	mu      sync.Mutex
	cache   map[string]*list.Element
	pages   list.List
	load    func(string) string
	loading map[string]*call
}

// New creates a new KeyStoreCache
func New(load KeyStoreCacheLoader) *KeyStoreCache {
	return &KeyStoreCache{
		load:    load.Load,
		cache:   make(map[string]*list.Element),
		loading: make(map[string]*call),
	}
}

// Get gets the key from cache, loads it from the source if needed
func (k *KeyStoreCache) Get(key string) string {
	k.mu.Lock()
	if e, ok := k.cache[key]; ok {
		k.pages.MoveToFront(e)
		v := e.Value.(page).Value
		k.mu.Unlock()
		return v
	}
	if c, ok := k.loading[key]; ok {
		// Someone else is already loading this key - wait for them
		// instead of issuing a redundant DB call.
		k.mu.Unlock()
		<-c.done
		return c.value
	}
	c := &call{done: make(chan struct{})}
	k.loading[key] = c
	k.mu.Unlock()

	// Load from the database without holding the lock, so misses on
	// other keys (and cache hits) can proceed concurrently.
	value := k.load(key)

	k.mu.Lock()
	delete(k.loading, key)
	if len(k.cache) >= CacheSize {
		end := k.pages.Back()
		delete(k.cache, end.Value.(page).Key)
		k.pages.Remove(end)
	}
	k.pages.PushFront(page{key, value})
	k.cache[key] = k.pages.Front()
	k.mu.Unlock()

	c.value = value
	close(c.done)
	return value
}
```

**Verified:** `go vet ./...` is clean. `go test -race -count=5 ./...`
passes 5/5 with correct results. `TestMain` took about 0.02–0.03s, against
about 2.1s for Approach 1. The 100 key loads now run at the same time.

This adds code but gives a real gain. More keys no longer slow the cache
linearly. Both approaches pass here. Approach 2 scales better.

## Key takeaways

- `go test -race` reports the map access. Also check `container/list.List`.
  It has no lock, and `MoveToFront` writes on a hit. `RWMutex` with
  `RLock()` on a hit is a common but wrong fix.
- `sync.Map` does not solve this. The LRU order is still in
  `container/list.List`, so the list still needs a lock.
- No race is not enough. `check_test.go` also checks
  `db.Calls <= callsPerCycle`. One version was race-free but made
  `db.Calls == 1500`, against a limit of 100. Its `cache` and `pages`
  sizes also disagreed.
- Approach 1 holds the lock during the load. It is simple and passes at
  this scale. It runs all misses one at a time, so cost follows
  `distinct keys × DB latency`.
- Approach 2 tracks a running load per key, like `singleflight`. It adds
  bookkeeping. Different keys can load at the same time.
