# Your Own singleflight: Deduping In-Flight Duplicate Calls

Your own tiny version of
[`golang.org/x/sync/singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight)'s
`Group`: N concurrent `Do` calls for the *same key* should share one
call to the slow underlying `fn` (see `Call` in `mockbackend.go`),
instead of each triggering it separately.

```
today (broken):                     goal:
3 concurrent Do("k", fn)            3 concurrent Do("k", fn)
   │      │      │                    │      │      │
   ▼      ▼      ▼                    └──┬───┴──────┘
  fn()   fn()   fn()  ← 3 calls          first one in becomes leader,
                                          runs fn() ONCE
                                                  │
                                     other 2 wait, share its (v, err),
                                     report shared = true
```

Right now `Do` just calls `fn` directly on the calling goroutine, so
`shared` is always `false` — for the worst possible reason: nothing is
ever actually shared.

**This is not exercise 17 again.** [17](../17-future-promise)'s
`Future` memoizes one result *forever*, for one key, built once. This
`Group` is keyed like the fixed 17, but never caches — once a call for
`key` finishes, `Group` forgets it completely:

```
no entry for "k" ──Do("k")──▶ entry created, leader runs fn ──fn returns──▶ entry deleted
        ▲                                                                       │
        └───────────────────── next Do("k") is a brand-new call ───────────────┘
```

Only callers genuinely *concurrent* with an in-flight call get to
share its result — and share its **error** too, not just a success.

## Your task

Fix `Group` so that:

- `Do(key string, fn func() (int, error)) (v int, err error, shared bool)`
  runs `fn`, making sure at most one call to `fn` is ever in flight per
  key.
- Any `Do` call arriving while another call for that same key is still
  in flight waits for it and returns its result (value **and** error)
  with `shared = true`, instead of calling `fn` again.
- The call that actually ran `fn` (or found nothing to join) returns
  `shared = false`.
- Once a key's call finishes, it's forgotten — the next `Do(key, ...)`
  starts a genuinely new call.
- Safe for any number of goroutines, any number of distinct keys.

Signature stays the same:

```go
func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool)
```

## Why this pattern matters

This is the standard fix for **cache-stampede** / **thundering-herd**:
a cache entry expires, dozens of requests miss at once, and without
deduping they'd all hammer the backend for the exact same data at the
exact same time. `singleflight` turns that into "one request does the
work, everyone else rides along for free."

If you need this for real, reach for
`golang.org/x/sync/singleflight` — production-hardened, and it also
recovers/re-panics consistently across all waiters if `fn` panics,
which this exercise leaves out to keep the core lesson in focus.

## Test your solution

```
go test
go test --race
```
