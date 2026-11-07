# Limit Service Time for Free-Tier Users

Each free user gets 10 seconds of processing time total. This limit
covers all requests, not each request. Premium users have no limit.

Go cannot force a goroutine to stop. The code can stop waiting for the
work. The work may still run in the background. `HandleRequest` receives
a `*User`:

```
HandleRequest(process, u)
        │
        ▼
  premium user? ──yes──▶ process() runs to completion, however long -
        │                never killed, ok=true
        │no
        ▼
  free user: remaining lifetime quota (10s total, all calls combined)
        │
        ├──▶ finishes before quota runs out ──▶ ok=true, credits the
        │                                       time it actually used
        │
        └──▶ hits the lifetime mark mid-run ──▶ cut loose right there,
                                                ok=false, credits only
                                                time actually burned -
                                                process keeps running
                                                anyway, orphaned
```

Right now `HandleRequest` does none of this. It calls `process()` and
waits for it. It always returns `true`:

```go
func HandleRequest(process func(), u *User) bool {
	process()
	return true
}
```

There is no timeout and no quota tracking. A free request always runs
to the end.

## The double-spend trap

Requests for one user can overlap. Checking the quota and using it
must happen as one safe step:

```
request A: check remaining (10s left) ──▶ ... sleeps 6s ...
request B: check remaining (10s left) ──▶ ... sleeps 6s ...
                     both saw room - together they need 12s of a 10s quota
```

Two 6 second requests must not both pass a 10 second quota.

## Your task

Fix `HandleRequest` so that:

- Premium users have `u.IsPremium == true`. They always run `process`
  to the end.
- Free users get 10 seconds total across all calls.
- Stop a free request exactly when its quota reaches the limit.
- Count only the time the request actually used.
- Make calls for the same user safe to run at the same time.
- Judge each request against real usage so far. Do not reserve the rest
  of the quota just because another request is running.

Keep the `HandleRequest` signature. You may add private fields to
`User`. You may choose the type of `TimeUsed`. An `int64` of seconds
is not precise enough for a partial call. Keyed test literals such as
`&User{ID: 1, IsPremium: false}` still work.

```go
func HandleRequest(process func(), u *User) bool
```

## Test your solution

```
go test
go test --race
```
