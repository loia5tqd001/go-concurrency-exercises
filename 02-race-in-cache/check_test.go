//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"strconv"
	"sync"
	"testing"
	"time"
)

// waitWithTimeout runs fn and fails the test if it doesn't return within
// timeout, instead of hanging toward Go's default 10-minute test timeout.
// Two known ways a solution can end up here: a per-key load-dedup
// ("singleflight") attempt that leaves a goroutine blocked forever on a
// done channel nobody closes, or a lock held across every Get - including
// on cache hits - that fully serializes 20ms DB loads into minutes.
func waitWithTimeout(t *testing.T, timeout time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("timed out after %s waiting for concurrent Get calls to finish", timeout)
	}
}

func run(t *testing.T) (*KeyStoreCache, *MockDB) {
	loader := Loader{
		DB: GetMockDB(),
	}
	cache := New(&loader)

	waitWithTimeout(t, 30*time.Second, func() {
		RunMockServer(cache, t)
	})

	return cache, loader.DB
}

func TestMain(t *testing.T) {
	cache, db := run(t)

	cacheLen := len(cache.cache)
	pagesLen := cache.pages.Len()
	if cacheLen != CacheSize {
		t.Errorf("Incorrect cache size %v", cacheLen)
	}
	if pagesLen != CacheSize {
		t.Errorf("Incorrect pages size %v", pagesLen)
	}
	if db.Calls > callsPerCycle {
		t.Errorf("Too much db uses %v", db.Calls)
	}
}

func TestLRU(t *testing.T) {
	loader := Loader{
		DB: GetMockDB(),
	}
	cache := New(&loader)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			value := cache.Get("Test" + strconv.Itoa(i))
			if value != "Test"+strconv.Itoa(i) {
				t.Errorf("Incorrect db response %v", value)
			}
			wg.Done()
		}(i)
	}
	waitWithTimeout(t, 10*time.Second, wg.Wait)

	if len(cache.cache) != 100 {
		t.Errorf("cache not 100: %d", len(cache.cache))
	}
	cache.Get("Test0")
	cache.Get("Test101")
	if _, ok := cache.cache["Test0"]; !ok {
		t.Errorf("0 evicted incorrectly: %v", cache.cache)
	}

}

// TestConcurrentHits hammers a handful of already-cached keys with heavy
// concurrent, repeated re-access. This specifically targets a common
// near-miss fix: an RWMutex that only takes an RLock() on the cache-hit
// path. That looks safe (multiple readers, no writer overlap on the map),
// but a hit also calls pages.MoveToFront - a write to the shared list -
// and RLock() does not exclude other RLock holders from each other. Only
// heavy, repeated contention on the SAME small set of keys makes that
// list race show up reliably under -race; a single pass over many
// distinct keys (as in TestMain/TestLRU) mostly moves each element to the
// front once and rarely collides.
func TestConcurrentHits(t *testing.T) {
	loader := Loader{DB: GetMockDB()}
	cache := New(&loader)

	const warmKeys = 4
	for i := 0; i < warmKeys; i++ {
		cache.Get("Test" + strconv.Itoa(i))
	}

	var wg sync.WaitGroup
	for g := 0; g < 500; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				cache.Get("Test" + strconv.Itoa(i%warmKeys))
			}
		}(g)
	}

	// Bounded wait: a solution that's correctly locked but never actually
	// caches anything (e.g. always misses through to the DB) turns every
	// one of these 100k calls into a 20ms load, fully serialized - that's
	// tens of minutes, not a fast pass. Fail well before Go's default
	// 10-minute test timeout instead of hanging toward it.
	waitWithTimeout(t, 30*time.Second, wg.Wait)
}
