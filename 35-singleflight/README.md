# Your Own singleflight: Deduping In-Flight Duplicate Calls

This is a small version of
[`golang.org/x/sync/singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight)'s
`Group`. N concurrent `Do` calls for the same key should share one call
to the slow underlying `fn`. See `Call` in `mockbackend.go`. They should
not each call it.

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

Today, `Do` calls `fn` directly on the calling goroutine. So `shared` is
always `false`. Nothing is shared.

**This is not exercise 17 again.** The `Future` in
[17](../17-future-promise) stores one result forever for one key. It is
built once. This `Group` also uses keys. But it never caches. Once a
call for `key` finishes, the group forgets it.

```
no entry for "k" ──Do("k")──▶ entry created, leader runs fn ──fn returns──▶ entry deleted
        ▲                                                                       │
        └───────────────────── next Do("k") is a brand-new call ────────────────┘
```

Only callers that overlap with an in-flight call share its result. They
also share its **error**, not just success.

## Your task

Fix `Group` so that:

- `Do(key string, fn func() (int, error)) (v int, err error, shared bool)`
  runs `fn`. It must allow at most one `fn` call in flight for each key.
- A `Do` call that arrives while the same key is in flight waits. It
  returns that result, including **error**, with `shared = true`. It
  must not call `fn` again.
- The call that ran `fn`, or found nothing to join, returns
  `shared = false`.
- Once a key's call finishes, forget the key. The next `Do(key, ...)`
  starts a new call.
- The code must be safe for any number of goroutines and distinct keys.

Keep the signature the same:

```go
func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool)
```

## Why this pattern matters

This pattern fixes a **cache stampede**, also called a **thundering
herd**. A cache entry expires, and many requests miss at once. Without
deduplication, they all hit the backend for the same data. `singleflight`
makes one request do the work. The others share its result.

If you need this in production, use
`golang.org/x/sync/singleflight`. It is hardened and recovers or
re-panics for all waiters when `fn` panics. This exercise leaves that
out to focus on the core lesson.

## Test your solution

```
go test
go test --race
```
