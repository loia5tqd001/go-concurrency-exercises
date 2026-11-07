# Clean Inactive Sessions to Prevent Memory Overflow

`SessionManager` stores sessions in a plain map. It does not use a
lock. It also never removes old sessions. The map keeps growing until
the process runs out of memory:

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

Right now `SessionManager` has two problems:

- `CreateSession`, `GetSessionData`, and `UpdateSessionData` read and
  write the map without a lock.
- A session stays in the map forever.

## Your task

Fix `SessionManager` so that:

- Make its three methods safe to call at the same time.
- Remove a session 5 to 7 seconds after its last create or update.

Signatures stay the same:

```go
func NewSessionManager() *SessionManager
func (m *SessionManager) CreateSession() (string, error)
func (m *SessionManager) GetSessionData(sessionID string) (map[string]interface{}, error)
func (m *SessionManager) UpdateSessionData(sessionID string, data map[string]interface{}) error
```

Add a `Close` method. The fake-clock tests call it before they return.
The starter has no `Stop` method. `Close` must stop any cleaner
goroutine you start.

## A constraint the tests hold you to

`check_test.go` uses the `testing/synctest` package and `synctest`. A call to
`time.Sleep(7 * time.Second)` returns at once. Every goroutine must
exit before the test returns. Make `Close` stop your cleaner before
then. Do not leave it running forever.

## Test your solution

```
go test
go test --race
```
