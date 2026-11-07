//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"testing"
	"time"
)

// referenceNumShards matches the shard count in the exercise.
const referenceNumShards = 16

// referenceShard follows the documented shard formula.
func referenceShard(key string) int {
	return int(key[0]) % referenceNumShards
}

// keyA and keyB must land in different shards:
//
//	keyA = "apple-key"  -> first byte 'a' (97), 97 % 16 = shard 1
//	keyB = "banana-key" -> first byte 'b' (98), 98 % 16 = shard 2
const (
	keyA = "apple-key"
	keyB = "banana-key"
)

func init() {
	if referenceShard(keyA) == referenceShard(keyB) {
		panic("test setup bug: keyA and keyB must land in different shards")
	}
}

// TestCacheCorrectness checks final values for several keys.
func TestCacheCorrectness(t *testing.T) {
	cache := NewCache()

	// Increment "counter" 100 times.
	for i := 0; i < 100; i++ {
		cache.Do("counter", func(cur int) int { return cur + 1 })
	}

	// Set "double" to 1 and double it 10 times.
	cache.Do("double", func(cur int) int { return 1 })
	for i := 0; i < 10; i++ {
		cache.Do("double", func(cur int) int { return cur * 2 })
	}

	// Add 1 through 20 to "sum".
	want := 0
	for i := 1; i <= 20; i++ {
		want += i
		cache.Do("sum", func(cur int) int { return cur + i })
	}

	got := cache.Do("counter", func(cur int) int { return cur })
	if got != 100 {
		t.Errorf(`cache.Do("counter", ...) final value = %d, want 100`, got)
	}

	got = cache.Do("double", func(cur int) int { return cur })
	if got != 1<<10 {
		t.Errorf(`cache.Do("double", ...) final value = %d, want %d`, got, 1<<10)
	}

	got = cache.Do("sum", func(cur int) int { return cur })
	if got != want {
		t.Errorf(`cache.Do("sum", ...) final value = %d, want %d`, got, want)
	}

	got = cache.Do("", func(cur int) int { return cur + 7 })
	if got != 7 {
		t.Errorf(`cache.Do("", ...) = %d, want 7 (empty keys must not panic while choosing a shard)`, got)
	}
}

// TestCacheSameKeySerializesCorrectly increments one key concurrently.
// Concurrent updates could read the same value and lose a count.
func TestCacheSameKeySerializesCorrectly(t *testing.T) {
	cache := NewCache()

	const goroutines = 50

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			cache.Do("shared-key", func(cur int) int { return cur + 1 })
		}()
	}
	wg.Wait()

	got := cache.Do("shared-key", func(cur int) int { return cur })
	if got != goroutines {
		t.Errorf(`final value for "shared-key" = %d, want %d (same-key operations must stay serialized)`, got, goroutines)
	}
}

// TestCacheDifferentKeysDontBlockEachOther checks separate shards.
// One key runs slow work while another key runs fast work.
// A global lock would make the fast call wait.
// A sharded cache would finish it quickly.
// This test uses real time because synctest ignores mutex waits.
func TestCacheDifferentKeysDontBlockEachOther(t *testing.T) {
	const slowWork = 200 * time.Millisecond
	const budget = 50 * time.Millisecond

	cache := NewCache()

	entered := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		cache.Do(keyA, func(cur int) int {
			close(entered)
			time.Sleep(slowWork)
			return cur + 1
		})
	}()

	// Wait until keyA holds its shard lock.
	<-entered

	start := time.Now()
	cache.Do(keyB, func(cur int) int { return cur + 1 })
	elapsed := time.Since(start)

	if elapsed >= budget {
		t.Errorf("cache.Do(keyB, ...) took %s, want < %s - "+
			"keyA and keyB are in different shards and must not block each other, "+
			"but this call appears to have waited behind keyA's %s lock hold", elapsed, budget, slowWork)
	}

	// Let the slow call finish before the test ends.
	<-done
}
