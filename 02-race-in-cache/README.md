# Race in an LRU Cache

`KeyStoreCache` has two parts: `cache` and `pages`. `cache` is a map
for fast lookup. `pages` is a `container/list.List` that tracks recent
use. `Get` changes both parts and uses no lock. Even a cache hit moves
the entry to the front of the list. Many goroutines can call `Get` at
the same time.

```
goroutine A: Get("x") hit  ──▶ MoveToFront(e) ─┐
goroutine B: Get("x") hit  ──▶ MoveToFront(e) ─┼─▶ same list node,
goroutine C: Get("y") miss ──▶ cache["y"] = e ─┘   no lock → race
```

Right now `Get` has no synchronization:

- **The map.** A miss writes `cache[key] = ...`. Another goroutine may
  read `cache[key]`. This can crash the program.
- **The list.** Hits and misses both change the same list. A miss calls
  `PushFront` and `Remove`. A hit calls `MoveToFront`.
- An `RWMutex` with `RLock` on a hit is unsafe. The hit still writes to
  the list.

## Your task

Make `Get` safe for many goroutines. Do not change what callers see.
Keep the same signatures:

```go
func New(load KeyStoreCacheLoader) *KeyStoreCache
func (k *KeyStoreCache) Get(key string) string
```

- No data race on the map or the list.
- The cache still holds at most `CacheSize` entries.
- The cache still removes the least recently used entry.
- Each key is loaded from the database at most once.

Try to finish the test in under 30 seconds. Under 5 seconds is better.
Hint: the database call is the slow part of `Get`.

## Test your solution

Use `go test --race`. The `--race` flag may also appear as `-race`.

```
go test --race
```

No output means the test passed. A race prints something like this:

```
==================
WARNING: DATA RACE
Write by goroutine 7:
...
==================
Found 3 data race(s)
```

## Further reading

* [A Tour of Go: Mutexes](https://go.dev/tour/concurrency/9)
* [The Go Memory Model](https://go.dev/ref/mem)
* [`sync` package docs](https://pkg.go.dev/sync)
* Real-world shape: [Mailgun's Go cache](https://www.mailgun.com/blog/golangs-superior-cache-solution-memcached-redis/), [Allegro's fast cache service](https://allegro.tech/2016/03/writing-fast-cache-service-in-go.html)
