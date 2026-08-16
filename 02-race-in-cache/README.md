# Race in an LRU Cache

`KeyStoreCache` is an LRU cache: a map for O(1) lookup, plus a
`container/list.List` that tracks recency so the least-recently-used
entry can be evicted once the cache fills up. `Get` mutates *both*
structures with no synchronization at all - including on a cache
**hit**, which calls `MoveToFront` to mark the entry as most-recently
used. This is the same shape as a real in-process cache in front of a
slow backing store (see the production writeups on Mailgun's and
Allegro's Go caches, linked below) - and production traffic calls
`Get` from many goroutines at once:

```
goroutine A: Get("x") hit  ──▶ MoveToFront(e) ─┐
goroutine B: Get("x") hit  ──▶ MoveToFront(e) ─┼─▶ same list node,
goroutine C: Get("y") miss ──▶ cache["y"] = e ─┘   no lock → race
```

Right now `Get` has zero synchronization:

- **The map.** One goroutine's `cache[key] = ...` on a miss races any
  other goroutine's `cache[key]` read - a plain map read concurrent
  with a write is undefined behavior in Go. `go test --race` reports it
  as a data race; run without `--race` and with enough concurrent
  callers it can instead crash outright with "fatal error: concurrent
  map writes".
- **The list.** `MoveToFront` on a *hit* and `PushFront`/`Remove` on a
  *miss* all mutate the same `container/list.List`, which has no
  locking of its own. This is the easy-to-miss half of the bug: it's
  tempting to reach for an `RWMutex` that only takes `RLock` on the
  hit path (since it "just reads" the cache), but the hit path still
  *writes* to the list via `MoveToFront` - so that fix still races.

## Your task

Make `Get` safe to call from any number of goroutines at once, without
changing its externally observable behavior. The signatures stay the
same:

```go
func New(load KeyStoreCacheLoader) *KeyStoreCache
func (k *KeyStoreCache) Get(key string) string
```

- No data race on the map or the list (`go test --race`).
- The cache still holds at most `CacheSize` entries and evicts the
  least-recently-used one - `cache` and `pages` must always agree on
  size.
- Each key is loaded from the database **at most once**. Narrowing the
  lock to just the map/list bookkeeping and reloading from the
  database *outside* of it keeps `-race` quiet but breaks this: two
  goroutines can both miss on the same key before either finishes
  loading it, each issuing its own DB call.

Try to get your test run under 30 seconds - and if you can, under 5.
*Hint*: the database load is by far the slowest part of `Get`.

## Test your solution

```
go test --race
```

No output means it's correct. A race prints something like:

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
