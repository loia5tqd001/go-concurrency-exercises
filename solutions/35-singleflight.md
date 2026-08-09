# Your Own singleflight: Deduping In-Flight Duplicate Calls — Suggested Solution

> **Spoiler warning.** This file contains a full worked solution for `35-singleflight/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

The starting point is a `Group` whose `Do` does no deduping at all:

```go
type Group struct{}

func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
	v, err = fn()
	return v, err, false
}
```

`Do` must:

- Run `fn` and return its result, making sure **at most one call to `fn` is ever in flight for a given key at a time**.
- Have any call that arrives while another call for the same key is in flight **wait for it and share its result — value AND error** — instead of calling `fn` again, reporting `shared = true`.
- Have the call that actually ran `fn` report `shared = false`.
- **Forget `key` once its call completes** — unlike [17](../17-future-promise)'s `Future`, this is not permanent memoization. A `Do` call made after the in-flight call has already finished is a brand new call.
- Be safe for concurrent use across any number of distinct keys.

## Why the naive version is wrong

Calling `fn` directly with no bookkeeping means every caller does its own independent work, no matter how many other callers are asking for the exact same key at the exact same time. `shared` being hard-coded to `false` happens to be "correct" only because nothing is ever shared.

Verified: running the current `check_test.go` against this naive `main.go` in a throwaway scratch copy fails two of the four tests:

```
--- FAIL: TestDoDedupesConcurrentCallers (20 callers reported shared=false, want 1; Call ran 20 times, want 1)
--- FAIL: TestDoPropagatesErrorToAllWaiters (Call ran 20 times, want 1)
```

`TestDoReturnsCorrectResult` and `TestDoForgetsAfterCompletion` both pass against the naive version — a single, uncontended call is trivially correct, and "forgets after completion" is trivially true when nothing is ever remembered in the first place.

## The fix: mutex-guarded map of in-flight calls, `sync.WaitGroup` as the join point

```go
package main

import "sync"

// call tracks a single in-flight (or just-finished) execution of fn
// for one key. wg is the join point: every duplicate caller Waits on
// it instead of calling fn again, then reads the result it recorded.
type call struct {
	wg  sync.WaitGroup
	v   int
	err error
}

// Group makes sure that only one execution of a given key's function
// is in flight at a time; concurrent duplicate calls wait for and
// share the original call's result instead of each running fn.
type Group struct {
	mu sync.Mutex
	m  map[string]*call
}

// Do executes fn and returns its results, making sure at most one
// execution of fn is in flight for a given key at a time.
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

Design notes:

- **The mutex only ever guards the map** — a lookup-or-insert, or a delete. It's never held across the call to `fn`, so unrelated keys never wait on each other, and a slow call for one key can't stall the bookkeeping for a different key.
- **Whoever wins the race to insert `key`'s `*call` into the map is the leader.** Everyone else who looks `key` up afterwards — while the leader is still running `fn` — finds the entry already there and joins it instead of creating their own.
- **`sync.WaitGroup` is the broadcast/join primitive here**, playing the same role `close(done)` played in 17: the leader adds 1 before releasing the map lock, runs `fn`, writes `c.v`/`c.err`, then calls `Done()`. Every joiner's `c.wg.Wait()` unblocks the instant that happens, and — just like a channel close — `Done()` establishes a happens-before edge with every `Wait()` it releases, so joiners are guaranteed to see the written `v`/`err` with no separate lock needed around them.
- **Errors ride along for free**, because `c.err` is just a second field on the same `*call` struct that `c.v` lives on — there's no separate success path and failure path to keep in sync. Whatever `fn` returns, successful or not, every joiner reads it back.
- **The leader deletes `key` from the map right after finishing**, under the mutex again. This is what makes the call transient instead of a permanent cache like 17's `Future`: the moment the leader is done, the entry is gone, so the *next* `Do(key, ...)` — even a nanosecond later — finds nothing in the map and becomes a brand new leader.

**Verified**: copied this exercise into a throwaway scratch directory, confirmed the naive `main.go` fails the two tests above, then dropped in this solution. `go vet ./...` is clean, and `go test -race -count=1 ./...` passed cleanly across 3 separate runs — including `TestDoDedupesConcurrentCallers` (20 concurrent callers, exactly 1 `Call` and exactly 1 `shared=false`) and `TestDoPropagatesErrorToAllWaiters` (20 concurrent callers against a key that always fails, all 20 see the same error, `Call` still ran exactly once).

## Key takeaways

- **This is `golang.org/x/sync/singleflight`, written out by hand.** The real package (`Group.Do`) is essentially this exact shape — mutex-guarded map, `sync.WaitGroup` per in-flight call, delete-on-completion — with extra production concerns layered on: panic recovery/re-propagation (`DoChan` for a channel-based variant, and consistent panic behavior across all waiters), which this exercise deliberately leaves out to keep the core lesson visible.
- **"Dedupe while in flight" and "cache forever" are different problems that happen to share a shape.** [17](../17-future-promise)'s `Future` never deletes its cache entry — that's correct there, because the whole point is permanent memoization for one key, constructed once. Here, deleting the entry the moment the leader finishes is the *entire point* — a cache-stampede fix that outlived its stampede would just be a cache with a confusing API, and would silently return stale-forever results for a key whose real value might change between calls.
- **A `sync.WaitGroup` (or a `close()`-based `done` channel) is a general "let N goroutines wait for and safely observe one goroutine's result" primitive**, independent of whether that result gets kept around afterward. The lifetime policy (forget immediately vs. cache forever vs. cache with a TTL) is a decision layered on top of the same join mechanism, not baked into it.
- **Sharing an error is not a special case if the result type already has room for one.** Structuring `call` as `{v, err}` instead of two independently-synchronized outcomes means the joiner code path (`c.wg.Wait(); return c.v, c.err, true`) doesn't need to know or care whether the leader's call succeeded — it just reads back whatever got written.
