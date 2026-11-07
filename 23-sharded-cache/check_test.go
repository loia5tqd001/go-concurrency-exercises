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

// referenceNumShards mirrors the shard count the exercise documents.
// The reference prefix avoids colliding with a solver's own numShards.
const referenceNumShards = 16

// referenceShard reproduces the exact sharding formula documented in
// main.go's header comment (shard by the key's first byte, mod
// referenceNumShards). It exists purely so this test file can
// demonstrate, by direct computation, that keyA and keyB below land
// in different shards under that scheme - it is not used to inspect
// the solver's actual Cache internals in any way.
func referenceShard(key string) int {
	return int(key[0]) % referenceNumShards
}

// keyA and keyB are two literal keys chosen so that, under the
// documented sharding formula (first byte mod referenceNumShards),
// they land in different shards:
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

// TestCacheCorrectness runs many sequential Do calls across a handful
// of keys and checks the final values land where a sequence of plain
// increments/updates would put them. It makes no assumption about
// timing or internal sharding, so it passes against both the naive
// single-mutex Cache and a correctly sharded one.
func TestCacheCorrectness(t *testing.T) {
	cache := NewCache()

	// "counter" gets incremented 100 times.
	for i := 0; i < 100; i++ {
		cache.Do("counter", func(cur int) int { return cur + 1 })
	}

	// "double" gets set to 1, then doubled 10 times.
	cache.Do("double", func(cur int) int { return 1 })
	for i := 0; i < 10; i++ {
		cache.Do("double", func(cur int) int { return cur * 2 })
	}

	// "sum" accumulates 1..20.
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

// TestCacheSameKeySerializesCorrectly launches many goroutines that
// all increment the SAME key concurrently. Sharding must never break
// the guarantee that operations on one key are serialized: if two
// increments on "shared-key" ever ran concurrently and both read the
// same "cur" before either wrote back, the final count would come out
// too low. Run with `go test -race` to also catch any data race.
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

// TestCacheDifferentKeysDontBlockEachOther is the test that actually
// proves sharding happened. keyA and keyB are chosen (see above) to
// land in different shards under the documented sharding scheme. One
// goroutine starts a slow operation on keyA; shortly after, the main
// test goroutine performs a fast operation on keyB and times it. If
// the cache still uses one global lock, keyB's call is forced to wait
// behind keyA's lock hold and takes roughly slowWork. If the keys are
// sharded independently, keyB's call finishes almost immediately.
//
// This uses the real wall clock rather than testing/synctest: a plain
// sync.Mutex.Lock block (exactly what the naive, un-sharded Cache
// does) is not a synctest-durable operation, so wrapping this in
// synctest.Test would deadlock forever against the naive
// implementation instead of failing fast. The margins here are wide
// (slowWork is 4x the budget on either side of the pass/fail line),
// so the assertion is not flaky in practice.
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

	// Wait until keyA's work is running. Do holds the relevant lock
	// for the whole callback, so this proves keyB's timing starts
	// after keyA's lock is held instead of relying on a scheduler sleep.
	<-entered

	start := time.Now()
	cache.Do(keyB, func(cur int) int { return cur + 1 })
	elapsed := time.Since(start)

	if elapsed >= budget {
		t.Errorf("cache.Do(keyB, ...) took %s, want < %s - "+
			"keyA and keyB are in different shards and must not block each other, "+
			"but this call appears to have waited behind keyA's %s lock hold", elapsed, budget, slowWork)
	}

	// Wait for the keyA goroutine to finish so it doesn't outlive the
	// test (which, under -race, could otherwise produce a confusing
	// report about a goroutine touching the cache after the test
	// returns).
	<-done
}
