//////////////////////////////////////////////////////////////////////
//
// KeyStoreCache is an LRU cache.
// A map gives fast lookup. A list tracks recent use.
// A full cache removes its least recently used entry.
// Get has no locking now.
// A hit still changes the list, so both parts need protection.
// See README.md for the task.
//

package main

import (
	"container/list"
)

// CacheSize sets the largest number of cached entries.
const CacheSize = 100

// KeyStoreCacheLoader loads cache values from another source.
type KeyStoreCacheLoader interface {
	// Load returns the value for a key.
	Load(string) string
}

type page struct {
	Key   string
	Value string
}

// KeyStoreCache stores string key-value pairs in an LRU cache.
type KeyStoreCache struct {
	cache map[string]*list.Element
	pages list.List
	load  func(string) string
}

// New creates an empty cache.
func New(load KeyStoreCacheLoader) *KeyStoreCache {
	return &KeyStoreCache{
		load:  load.Load,
		cache: make(map[string]*list.Element),
	}
}

// Get returns a cached value or loads it.
func (k *KeyStoreCache) Get(key string) string {
	if e, ok := k.cache[key]; ok {
		k.pages.MoveToFront(e)
		return e.Value.(page).Value
	}
	p := page{key, k.load(key)}
	if len(k.cache) >= CacheSize {
		end := k.pages.Back()
		delete(k.cache, end.Value.(page).Key)
		k.pages.Remove(end)
	}
	k.pages.PushFront(p)
	k.cache[key] = k.pages.Front()
	return p.Value
}

// Loader loads cache values from MockDB.
type Loader struct {
	DB *MockDB
}

// Load reads a value from the database.
func (l *Loader) Load(key string) string {
	val, err := l.DB.Get(key)
	if err != nil {
		panic(err)
	}

	return val
}

func main() {
	loader := Loader{DB: GetMockDB()}
	cache := New(&loader)
	RunMockServer(cache, nil)
}
