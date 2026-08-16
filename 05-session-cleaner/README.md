# Clean Inactive Sessions to Prevent Memory Overflow

`SessionManager` stores every session in a plain, unsynchronized map
and never removes one — the kind of in-process session store a small
service reaches for before it needs Redis, and the exact shape that
quietly runs a long-lived process out of memory once nobody looks at
old data again:

```
today: CreateSession/UpdateSessionData ──▶ sessions[id] = {data}
                                                  │
                                 nothing ever deletes it
                                                  │
                                                  ▼
                                 map only grows ──▶ OOM

goal:  CreateSession/UpdateSessionData ──▶ sessions[id] = {data, ...}
                                                  │
                                5-7s pass with no further touch
                                                  │
                                                  ▼
                                 session is reclaimed
```

Right now `SessionManager`:

- Has no synchronization at all — `CreateSession`, `GetSessionData`,
  and `UpdateSessionData` all read/write the shared map directly, so
  concurrent callers race.
- Never removes a session. Once created, it lives in the map forever.

## Your task

Fix `SessionManager` so that:

- `CreateSession`, `GetSessionData`, and `UpdateSessionData` are safe
  to call concurrently, from any number of goroutines.
- Any session that hasn't been touched (created or updated) in the
  last 5 seconds gets reclaimed — anytime between 5 and 7 seconds
  after its last touch, not sooner, and not indefinitely later.

Signatures stay the same:

```go
func NewSessionManager() *SessionManager
func (m *SessionManager) CreateSession() (string, error)
func (m *SessionManager) GetSessionData(sessionID string) (map[string]interface{}, error)
func (m *SessionManager) UpdateSessionData(sessionID string, data map[string]interface{}) error
```

## A constraint the tests hold you to

`check_test.go`'s timing tests run inside `testing/synctest` on a fake
clock, so `time.Sleep(7 * time.Second)` finishes instantly instead of
actually waiting seconds — but `synctest` enforces one rule strictly:
when the test function returns, every goroutine it started (directly
or transitively) must already have exited. A cleaner that's one
goroutine looping forever — wake up periodically, sweep whatever's
expired, go back to sleep, nothing ever stops it — is still durably
blocked on its own wakeup source the instant the test returns, and
that panics the test instead of just failing an assertion. There's
also no `Stop`/`Close` in the pinned API to bound such a goroutine's
life from outside — whatever goroutine you start has to reach its own
exit before the test function returns.

## Test your solution

```
go test
go test --race
```
