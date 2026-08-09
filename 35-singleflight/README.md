# Your Own singleflight: Deduping In-Flight Duplicate Calls

Given is a `Group` type meant to be your own tiny version of
[`golang.org/x/sync/singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight)'s
`Group`: a way to make sure that, no matter how many goroutines call
`Do` for the SAME key at the same time, the slow underlying call (see
`Call` in `mockbackend.go`) only actually runs once - every concurrent
caller for that key blocks and shares the one result (or error)
instead of triggering a redundant call of its own.

Right now `Group` does none of that. `Do` just calls `fn` directly, on
the calling goroutine - so N concurrent callers for the same key
trigger N separate calls to `fn`, each paying the full latency and
each hitting the backend independently.

**This is not exercise 17 again.** [17](../17-future-promise) builds a
`Future` that memoizes a result *forever*, for exactly one key,
constructed once. This exercise builds something that:

- Is keyed, like the fixed version of 17 - many independent calls for
  many different keys, each deduped against concurrent calls for that
  same key.
- Is **not** cached forever: once a call for a key finishes, `Group`
  forgets it completely. A `Do` call made a moment later for the same
  key is a brand new call, not a cache hit - only callers genuinely
  *concurrent* with an in-flight call get to share its result.
- Must share **errors** too, not just successful values - every waiter
  on a failed in-flight call must see that same failure, not silently
  retry on its own.

Your task is to fix `Group` so that:

- `Do(key string, fn func() (int, error)) (v int, err error, shared bool)`
  runs `fn` and returns its result, making sure at most one call to
  `fn` is ever in flight for a given key at a time.
- Any `Do` call that arrives for a key while another call for that
  SAME key is still in flight does not call `fn` again - it waits for
  the in-flight call to finish and returns its result (value **and**
  error) instead, with `shared = true`.
- The `Do` call that actually ran `fn` (or found no in-flight call to
  join) returns `shared = false`.
- Once a call for `key` finishes, `Group` forgets it: the next
  `Do(key, ...)` call, even moments later, starts a genuinely new call
  to `fn` rather than replaying a cached result.
- Safe to call concurrently, for any number of distinct keys at once,
  from any number of goroutines.

The signature must stay the same:

```go
func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool)
```

## Why this pattern matters

This is the standard fix for **cache-stampede** / **thundering-herd**
problems: a cache entry expires, dozens of requests miss at once, and
without deduping they'd all hammer the same slow backend for the exact
same data at the exact same time - when really only one of them needed
to. `singleflight` (and this exercise) turns that into "one request
does the work, everyone else rides along for free."

If you need this for real, don't hand-roll the keyed cache -
`golang.org/x/sync/singleflight` is exactly this, production-hardened
(it also recovers and re-panics consistently across all waiters if
`fn` panics, which this exercise leaves out to keep the core lesson in
focus).

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
