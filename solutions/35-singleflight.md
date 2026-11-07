# Your Own singleflight: Share In-Flight Duplicate Calls — Suggested Solution

> **Spoiler warning.** Try the exercise first. Come back if you are stuck.

## The problem

`Do` calls `fn` directly. It does not deduplicate or share work:

```go
type Group struct{}

func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
	v, err = fn()
	return v, err, false
}
```

`shared` is always `false`. That is technically correct for a bad
reason: nothing is shared. `Do` must follow three rules. First, it
makes at most one call to `fn` in flight per key. Second, every other
concurrent caller for that key waits and shares the value **and** the
error. Third, it forgets the key when the call finishes. This differs
from [17](../17-future-promise), whose `Future` is permanent.

**Verified**: I ran `check_test.go` against this naive `main.go` in a
scratch copy. It fails two of the four tests:

```
--- FAIL: TestDoDedupesConcurrentCallers (20 callers reported shared=false, want 1; Call ran 20 times, want 1)
--- FAIL: TestDoPropagatesErrorToAllWaiters (Call ran 20 times, want 1)
```

`TestDoReturnsCorrectResult` and `TestDoForgetsAfterCompletion` pass
trivially. A single uncontended call is correct. "Forgets" is vacuously
true when nothing is stored.

## The fix: a mutex-guarded map and `sync.WaitGroup` as the join point

```go {18,20,33}
type call struct {
	wg  sync.WaitGroup
	v   int
	err error
}

type Group struct {
	mu sync.Mutex
	m  map[string]*call
}

func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
	g.mu.Lock()
	if g.m == nil {
		g.m = make(map[string]*call)
	}

	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.v, c.err, true
	}

	c := new(call)
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.v, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()

	return c.v, c.err, false
}
```

```
Do("k")   Do("k")   Do("k")            leader:
   │         │         │                 g.mu: insert *call{}, unlock
   ▼         ▼         ▼                 fn() runs (mutex NOT held)
 first one in → LEADER                   c.v, c.err = result
 the rest    → find *call, join it       c.wg.Done()  ← broadcasts
   │                                      g.mu: delete key, unlock
   └── c.wg.Wait() ──────────────────────────┘
          returns c.v, c.err, shared=true      leader returns shared=false
```

- **The mutex protects only the map.** It covers lookup, insert, and
  delete. Never hold it during `fn`, so unrelated keys do not wait for
  each other.
- **Leader:** The goroutine that inserts `key`'s `*call` is the leader.
  Anyone who finds that call while `fn` runs joins it instead.
- **`sync.WaitGroup` is the join primitive.** It plays the role that
  `close(done)` played in 17. `Done()` creates a happens-before edge
  with every `Wait()` it releases. Joiners then see `c.v` and `c.err`
  without another lock.
- **Errors ride along.** `c.err` is another field in the same struct as
  `c.v`. There is no separate success or failure path to keep in sync.
- **Delete the entry after the call finishes.** This makes the work
  transient, not a cache. The next `Do(key, ...)` finds nothing and
  becomes a new leader.

**Verified**: the naive `main.go` fails as shown above. The fix is
`go vet` clean. It passed `go test -race -count=1` in three separate
runs. In each run, 20 concurrent callers produced exactly 1 `Call` and
exactly 1 `shared=false`. This held for a successful key and for a key
where `fn` always errors.

## Key takeaways

- **This is `golang.org/x/sync/singleflight`, by hand.** It uses a
  mutex-guarded map, one `WaitGroup` per key, and delete-on-completion.
  It omits panic recovery and re-propagation.
- **"Dedupe while in flight" is not "cache forever."** The two ideas
  look similar. 17's `Future` never deletes its entry because permanent
  memoization is the point there. Here, deleting on completion is the
  point. A stampede fix that outlives its stampede would serve stale
  results forever.
- **Join primitive:** A `WaitGroup` or `close()`-based `done` channel
  can let many goroutines observe one result. The mechanism does not
  decide how long to keep the result. Lifetime policy sits on top.
- **Errors:** With `call{v, err}`, the result type can hold the error.
  The joiner path needs no special case. It does not care whether `fn`
  succeeded.
