# Your Own singleflight: Deduping In-Flight Duplicate Calls — Suggested Solution

> **Spoiler warning.** Try solving it yourself first — come back if you're stuck.

## The problem

`Do` currently just calls `fn` directly — no dedup, no sharing:

```go
type Group struct{}

func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
	v, err = fn()
	return v, err, false
}
```

`shared` is always `false`, which happens to be "correct" here for the
worst possible reason: nothing is ever shared. `Do` must make at most
one call to `fn` in flight per key, have every other concurrent caller
for that key wait and share the result — value **and** error — and
forget the key entirely once that call finishes (unlike
[17](../17-future-promise)'s permanent `Future`).

**Verified**: running `check_test.go` against this naive `main.go` in
a throwaway scratch copy fails two of the four tests:

```
--- FAIL: TestDoDedupesConcurrentCallers (20 callers reported shared=false, want 1; Call ran 20 times, want 1)
--- FAIL: TestDoPropagatesErrorToAllWaiters (Call ran 20 times, want 1)
```

(`TestDoReturnsCorrectResult` and `TestDoForgetsAfterCompletion` pass
trivially — a single uncontended call is correct, and "forgets" is
vacuously true when nothing is ever remembered.)

## The fix: mutex-guarded map, `sync.WaitGroup` as the join point

```go
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

- **The mutex only ever guards the map** — lookup-or-insert, or
  delete. Never held across `fn`, so unrelated keys never wait on each
  other.
- **Whoever inserts `key`'s `*call` is the leader**; everyone who looks
  it up while the leader is still running `fn` joins it instead.
- **`sync.WaitGroup` is the broadcast/join primitive**, playing the
  role `close(done)` played in 17: `Done()` establishes a
  happens-before edge with every `Wait()` it releases, so joiners are
  guaranteed to see `c.v`/`c.err` with no extra lock needed.
- **Errors ride along for free** — `c.err` is just a second field on
  the same struct as `c.v`, so there's no separate success/failure
  path to keep in sync.
- **Delete right after finishing** is what makes this transient instead
  of a permanent cache: the next `Do(key, ...)` finds nothing and
  becomes a brand new leader.

**Verified**: naive `main.go` fails as shown above; the fix is
`go vet` clean and passed `go test -race -count=1` cleanly across 3
separate runs, including 20 concurrent callers producing exactly 1
`Call` and exactly 1 `shared=false`, both for a successful key and for
one where `fn` always errors.

## Key takeaways

- **This is `golang.org/x/sync/singleflight`, by hand** — mutex-guarded
  map + per-key `WaitGroup` + delete-on-completion, minus panic
  recovery/re-propagation.
- **"Dedupe while in flight" ≠ "cache forever"**, despite sharing a
  shape. 17's `Future` never deletes its entry (correct there — the
  point is permanent memoization). Here, deleting on completion *is*
  the point — a stampede fix that outlived its stampede would silently
  serve stale results forever.
- **A `WaitGroup` (or `close()`-based `done`) is a general "let N
  goroutines observe one goroutine's result" primitive**, independent
  of whether that result is kept afterward. Lifetime policy is a layer
  on top, not baked into the join mechanism.
- **Sharing an error isn't a special case if the result type already
  has room for one** — `call{v, err}` means the joiner path doesn't
  need to know or care whether `fn` succeeded.
