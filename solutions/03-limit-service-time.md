# Limit Service Time for Free-Tier Users — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `03-limit-service-time/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

The starting point has no limit logic:

```go
type User struct {
	ID        int
	IsPremium bool
	TimeUsed  int64 // in seconds
}

func HandleRequest(process func(), u *User) bool {
	process()
	return true
}
```

`HandleRequest` must follow these rules:

- Premium users can run `process` for as long as they want.
- A free user gets 10 seconds in total across all requests.
- Kill a free request when it reaches the 10 second limit.
- Track only the time a free request actually uses.
- Calls for the same user must be safe at the same time.
- Two 6 second requests must not both use a 10 second quota.
- Judge a request by the real use of a running request. Do not guess its
  worst case. Do not reject a request just because another one is running.

Go cannot force a goroutine to stop. You can start `process` in a
goroutine. Then use `select` to wait for completion or a timeout. If the
timeout wins, stop waiting. The `process` goroutine keeps running.

## Why the naive version is wrong

`HandleRequest` calls `process()` and always returns `true`. It has these
problems:

- It never stops a free user's long job.
- It does not separate premium users from free users.
- It has no per-user state to track quota.
- It can double-spend quota during concurrent calls.

The current `check_test.go` fails these tests:
`TestHandleRequest_FreeUser_SlowProcessKilled`,
`TestHandleRequest_FreeUser_AccumulatedTimeExceeded`,
`TestHandleRequest_FreeUser_QuotaIsPerUser`, and
`TestHandleRequest_FreeUser_ConcurrentRequestsDoNotDoubleSpendQuota`.

## Approach 1: `context.WithTimeout` racing `process` in a goroutine, one mutex per user

```go {14,16,35,42,57,61}
package main

import (
	"context"
	"sync"
	"time"
)

// User defines the UserModel. Use this to check whether a User is a
// Premium user or not
type User struct {
	ID        int
	IsPremium bool
	TimeUsed  time.Duration // accumulated processing time actually used, across all requests

	mu sync.Mutex // serializes requests for this user and guards TimeUsed
}

// freeQuota is the total processing time (across all requests) a free
// user gets before being killed.
const freeQuota = 10 * time.Second

// HandleRequest runs the processes requested by users. Returns false
// if process had to be killed
func HandleRequest(process func(), u *User) bool {
	if u.IsPremium {
		// Premium users are never limited: run synchronously, no timeout.
		process()
		return true
	}

	u.mu.Lock()
	defer u.mu.Unlock()

	remaining := freeQuota - u.TimeUsed
	if remaining <= 0 {
		// Quota already exhausted by earlier requests: kill immediately,
		// no need to even start the process.
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	defer cancel()

	done := make(chan struct{})
	start := time.Now()
	go func() {
		process()
		close(done)
	}()

	select {
	case <-done:
		// Completed within quota: record the time it actually used.
		u.TimeUsed += time.Since(start)
		return true
	case <-ctx.Done():
		// Timed out: it consumed exactly the remaining quota. The
		// goroutine above is left running in the background (Go has no
		// way to forcibly kill it), but we stop waiting on it.
		u.TimeUsed += remaining
		return false
	}
}

func main() {
	RunMockServer()
}
```

Design notes:

- **Premium users skip the limit.** `process()` runs inline. It uses no
  timeout and no lock.
- **`TimeUsed` is a `time.Duration`.** The starting field is `int64`,
  which loses partial seconds. `time.Duration` keeps them.
- A job killed after 2.1s adds 2.1s, not 2s.
- **Each `User` has one `sync.Mutex`.** Zero values work, so test literals
  like `&User{ID: ..., IsPremium: ...}` still work. The lock makes all
  requests for one user run one at a time. The quota update is protected
  too.
- Two 6s requests cannot both use a fresh 10s quota. The second request
  waits for the first to finish and record its real use. The second then
  checks `remaining`. It does not reserve worst-case quota in advance.
- `remaining := freeQuota - u.TimeUsed` is computed under the lock. It is
  the quota left now. If it is `<= 0`, `process` does not start.
- On timeout, run `u.TimeUsed += remaining`. The timeout fires after
  exactly that much time. Do not guess a longer duration.
- A killed request leaves its goroutine running. Go cannot stop it. That
  goroutine does not use `u.mu`, so it cannot block later requests.

**Verified:** the naive stub fails the current `check_test.go`. This
solution passes `go vet ./...` and `go test -race -count=3 ./...`. It
passes all tests, including the synctest tests and the two real-clock
concurrency tests.

## Variant: `time.Timer` instead of `context`

This version uses `timer := time.NewTimer(remaining)`,
`defer timer.Stop()`, and `<-timer.C`. It replaces
`context.WithTimeout`, `defer cancel()`, and `<-ctx.Done()`.
`process` is a plain `func()`. It does not accept a `context.Context`.
Both versions are correct here.

Another design reserves `remaining` under the lock. It then unlocks and
runs the race. Afterward, it locks again and refunds unused time. This
lets calls for one user run at the same time. But the second call must
reserve the worst case. It can be rejected even if the first call finishes
early. `TestHandleRequest_FreeUser_ConcurrentRequestNotRejectedOnEarlierEarlyFinish`
rejects that tradeoff. This exercise values real usage over concurrent
calls for one user. Approach 1 therefore holds the lock for the full call.

## Key takeaways

- Go cannot force a goroutine to stop. "Killing" means waiting for a
  timeout or a `done` channel with `select`. Then stop waiting. The
  goroutine keeps running.
- Store `TimeUsed` as a `time.Duration`, not whole seconds. This keeps
  partial seconds exact.
- For a repeated quota, compute `remaining := quota - TimeUsed` on every
  call. Use it as the timeout.
- On timeout, add exactly `remaining` to usage. That is the time already
  used.
- Hold one user's mutex for the full `HandleRequest` call. Check quota,
  run the race, and record usage under the lock. This stops double-spend.
  It also avoids worst-case guesses.
- Keep the mutex per user. Store it inside `User` as an unexported zero
  value. Different users should not block each other.
- Run premium `process()` inline. They have no timeout. This is simpler
  and needs no separate path.
