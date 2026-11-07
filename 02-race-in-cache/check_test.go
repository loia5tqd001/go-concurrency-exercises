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

// waitWithTimeout fails if fn does not return in time.
// A broken solution may leave a goroutine blocked forever.
// Another may hold a lock across every Get.
// The timeout makes either case fail fast.
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

// TestConcurrentHits repeatedly reads a few cached keys.
// A cache hit changes the shared list.
// A read lock alone does not protect that change.
// Heavy use of few keys makes the race easier to find.
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

	// A solution that never caches turns these calls into slow DB loads.
	// Fail before the test runs for many minutes.
	waitWithTimeout(t, 30*time.Second, wg.Wait)
}
