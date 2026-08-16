# Limit Service Time for Free-Tier Users

Your video processing service has a freemium model: every **free**
user gets 10 seconds of processing time total, accumulated across
*all* of their requests, not 10 seconds per call. Once that lifetime
quota is spent, the next request gets killed the instant the 10s mark
is hit - even mid-run. **Premium** users are never limited.

Go has no way to forcibly stop a running goroutine, so "killing" a
process really means racing a timeout against completion and walking
away the moment the timeout wins - the process goroutine itself keeps
running, orphaned, in the background:

```
HandleRequest(process, u)
        │
        ▼
  premium user? ──yes──▶ process() runs to completion, however long -
        │                 never killed, ok=true
        │no
        ▼
  free user: remaining lifetime quota (10s total, all calls combined)
        │
        ├──▶ finishes before quota runs out ──▶ ok=true, credits the
        │                                        time it actually used
        │
        └──▶ hits the lifetime mark mid-run ──▶ cut loose right there,
                                                  ok=false, credits only
                                                  time actually burned -
                                                  process keeps running
                                                  anyway, orphaned
```

Right now `HandleRequest` does none of this - it calls `process()`
synchronously and always returns `true`:

```go
func HandleRequest(process func(), u *User) bool {
	process()
	return true
}
```

No timeout, no premium/free distinction, no per-user quota tracking at
all - a free user's request runs to completion no matter how long it
takes.

## The double-spend trap

Checking "is there quota left?" and spending it can't be two separate
steps once requests for the same user can overlap:

```
request A: check remaining (10s left) ──▶ ... sleeps 6s ...
request B: check remaining (10s left) ──▶ ... sleeps 6s ...
                     both saw room - together they need 12s of a 10s quota
```

A request must reserve/record its share atomically with the check, or
two concurrent 6s requests against a 10s quota can both slip through.

## Your task

Fix `HandleRequest` so that:

- **Premium** users (`u.IsPremium == true`) always run `process` to
  completion - never killed, no timeout.
- **Free** users get 10 seconds of processing time total, accumulated
  across every call `HandleRequest` makes for that `*User` - not 10s
  per individual request.
- Once a request would push a free user's lifetime usage past 10s, it
  gets killed right at the 10s mark - not allowed to run to
  completion, and not killed before it needed to be.
- Only the time actually used before a kill gets credited against the
  quota - not a full timeout's worth.
- Safe to call concurrently for the same `*User`: two overlapping
  requests must not both succeed if together they'd exceed the quota,
  and a request must be judged against a sibling's *real* usage, not a
  worst-case guess about how long it might still run.

`HandleRequest`'s signature stays the same. `User` may gain unexported
fields (its existing fields are built with keyed literals, e.g.
`&User{ID: 1, IsPremium: false}`, so this is safe) and `TimeUsed`'s
type is yours to choose - seconds-as-`int64` loses precision the
moment a kill happens partway through a call:

```go
func HandleRequest(process func(), u *User) bool
```

## Test your solution

```
go test
go test --race
```
