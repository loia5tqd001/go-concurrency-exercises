//////////////////////////////////////////////////////////////////////
//
// Cache is correct, but one lock covers every key.
// A slow call for one key blocks calls for all other keys.
//
// Your task is to split the cache into 16 shards.
// Each shard needs its own mutex and map.
// Calls for different shards must not wait for each other.
// Calls for the same key must still run one at a time.
// Choose the shard from the key's first byte:
//
//     shardIndex := int(key[0]) % numShards
//
// Keep these signatures:
//
//     func NewCache() *Cache
//     func (c *Cache) Do(key string, work func(cur int) int) int
//

package main

import (
	"fmt"
	"sync"
	"time"
)

// Cache stores one int for each key.
// The current code uses one lock for the whole cache.
type Cache struct {
	mu   sync.Mutex
	data map[string]int
}

// NewCache returns an empty cache.
func NewCache() *Cache {
	return &Cache{data: make(map[string]int)}
}

// Do updates key with work.
// Its lock covers the full work call.
func (c *Cache) Do(key string, work func(cur int) int) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	cur := c.data[key]
	next := work(cur)
	c.data[key] = next
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
	fmt.Println("(with a single global mutex, this is forced to wait ~200ms for the unrelated, slow \"a\" operation)")

	wg.Wait()
}
