# Clean Inactive Sessions to Prevent Memory Overflow — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `05-session-cleaner/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

`SessionManager` stores sessions in `map[string]Session`. It has no lock
and no expiry. You must fix two issues:

1. **Memory growth.** Sessions are never removed. A long process will run
   out of memory. Remove a session 5 to 7 seconds after its last create or
   update. It does not need to be instant, but it must not wait forever.
2. **Races.** `CreateSession`, `GetSessionData`, and `UpdateSessionData`
   read and write `sessions` without a lock. `TestSessionManagerConcurrentAccess`
   calls all three methods from many goroutines under `-race`. This causes
   a data race. A background cleaner would add a third writer.

## Why the naive version is wrong

The starting `main.go` fails the current `check_test.go`:

- `TestSessionManagersCleaner` and
  `TestSessionManagersCleanerAfterUpdate` fail. Nothing removes an old
  session, so `GetSessionData` never returns `ErrSessionNotFound`.
- `TestSessionManagerConcurrentAccess` fails under `go test -race`.
  `CreateSession` and `UpdateSessionData` both change
  `m.sessions[id] = ...` without a lock.

## A constraint you can't design around: `testing/synctest`

`check_test.go` uses Go's `testing/synctest` package. It runs
`TestSessionManagersCreationAndUpdate`, `TestSessionManagersCleaner`, and
`TestSessionManagersCleanerAfterUpdate` on a fake clock. A call to
`time.Sleep(7 * time.Second)` finishes at once.

`synctest.Test` has a strict rule. Every goroutine in the test bubble
must exit before the test function returns. A goroutine still blocked on
a channel or ticker causes a panic:

```
panic: deadlock: main bubble goroutine has exited but blocked goroutines remain
```

This matters here. A `time.Ticker` loop in `NewSessionManager` starts a
long-lived goroutine. The committed tests never call `Close` or `Stop`.

Use no persistent goroutine for this suite. Approach 1 uses one-shot
timers. Approach 2 shows why a ticker sweeper does not fit.

## Approach 1: per-session `time.AfterFunc` timer (recommended)

Give each session its own one-shot timer. It fires 5 seconds after the
last update. `UpdateSessionData` resets that same timer. It does not
replace it. Each session then has at most one pending callback. The
callback goroutine lives only for the `AfterFunc` duration.

```go {53,73,109}
package main

import (
	"errors"
	"log"
	"sync"
	"time"
)

// sessionTTL is how long a session may go without being updated
// before it is reclaimed.
const sessionTTL = 5 * time.Second

// SessionManager keeps track of all sessions from creation, updating
// to destroying.
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]Session
}

// Session stores the session's data
type Session struct {
	Data        map[string]interface{}
	lastUpdated time.Time
	timer       *time.Timer
}

// NewSessionManager creates a new sessionManager
func NewSessionManager() *SessionManager {
	m := &SessionManager{
		sessions: make(map[string]Session),
	}
	return m
}

// expire is scheduled via time.AfterFunc to fire sessionTTL after the
// most recent (Create|Update)SessionData call for sessionID. Because
// UpdateSessionData resets the same timer instead of creating a new
// one, at most one of these callbacks is ever pending per session.
func (m *SessionManager) expire(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return
	}

	// Guard against a callback that lost the race with a concurrent
	// update: if the session was touched again after this timer was
	// scheduled, leave it alone (Reset in UpdateSessionData already
	// pushed the deadline out further).
	if time.Since(session.lastUpdated) < sessionTTL {
		return
	}

	delete(m.sessions, sessionID)
}

// CreateSession creates a new session and returns the sessionID
func (m *SessionManager) CreateSession() (string, error) {
	sessionID, err := MakeSessionID()
	if err != nil {
		return "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.sessions[sessionID] = Session{
		Data:        make(map[string]interface{}),
		lastUpdated: time.Now(),
		timer:       time.AfterFunc(sessionTTL, func() { m.expire(sessionID) }),
	}

	return sessionID, nil
}

// ErrSessionNotFound returned when sessionID not listed in
// SessionManager
var ErrSessionNotFound = errors.New("SessionID does not exists")

// GetSessionData returns data related to session if sessionID is
// found, errors otherwise
func (m *SessionManager) GetSessionData(sessionID string) (map[string]interface{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return session.Data, nil
}

// UpdateSessionData overwrites the old session data with the new one
func (m *SessionManager) UpdateSessionData(sessionID string, data map[string]interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}

	// Renew expiry: push the *same* timer out instead of leaking a
	// fresh one, so exactly one AfterFunc callback is ever in flight
	// per session.
	session.timer.Reset(sessionTTL)

	m.sessions[sessionID] = Session{
		Data:        data,
		lastUpdated: time.Now(),
		timer:       session.timer,
	}

	return nil
}

func main() {
	m := NewSessionManager()
	sID, err := m.CreateSession()
	if err != nil {
		log.Fatal(err)
	}
	log.Println("Created new session with ID", sID)

	data := make(map[string]interface{})
	data["website"] = "longhoang.de"

	if err := m.UpdateSessionData(sID, data); err != nil {
		log.Fatal(err)
	}
	log.Println("Update session data, set website to longhoang.de")

	updatedData, err := m.GetSessionData(sID)
	if err != nil {
		log.Fatal(err)
	}
	log.Println("Get session data:", updatedData)
}
```

**Why this works:**

- It frees memory even if nobody calls `GetSessionData`.
- One mutex, `m.mu`, protects every use of `m.sessions`. It also protects
  `expire`. A timer cannot race with `Create`, `Update`, or `Get`.
- Keep the same `*time.Timer` and call `session.timer.Reset(...)` on
  update. A new timer leaves the old one running. The old callback sees
  `time.Since(...) < sessionTTL`, so it does nothing. Nothing then checks
  the new deadline. Every test can still pass while the leak returns.
- The timer fires at `lastUpdated + 5s`. That is always within `[5s, 7s]`.
- The `AfterFunc` callback goroutine is short-lived. It does not leave a
  goroutine blocked in the `synctest` bubble.
**Verified:** in a scratch directory, not the live `05-session-cleaner/`.
`go vet ./...` is clean. `go test -race ./...` and
`go test -race -count=3 ./...` pass all four tests:
`TestSessionManagersCreationAndUpdate`, `TestSessionManagersCleaner`,
`TestSessionManagersCleanerAfterUpdate`, and
`TestSessionManagerConcurrentAccess`. The last test uses 20 sessions, 3
goroutines, and 2000 iterations.

## Approach 2: `time.Ticker`-driven background sweeper

This is the common textbook design. Start one goroutine in
`NewSessionManager`. It wakes on a ticker every few seconds. It takes the
lock and removes old sessions:

```go {8,9,25,44,47}
const sessionTTL = 5 * time.Second
const cleanupInterval = 2 * time.Second

type SessionManager struct {
	mu        sync.Mutex
	sessions  map[string]Session
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func NewSessionManager() *SessionManager {
	m := &SessionManager{
		sessions: make(map[string]Session),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go m.cleanupLoop()
	return m
}

func (m *SessionManager) cleanupLoop() {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	defer close(m.done)
	for {
		select {
		case <-ticker.C:
			now := time.Now()
			m.mu.Lock()
			for id, s := range m.sessions {
				if now.Sub(s.lastUpdated) > sessionTTL {
					delete(m.sessions, id)
				}
			}
			m.mu.Unlock()
		case <-m.stop:
			return
		}
	}
}

// Close stops the sweeper and waits for cleanupLoop to exit.
func (m *SessionManager) Close() {
	m.closeOnce.Do(func() {
		close(m.stop)
		<-m.done
	})
}
```

This uses one goroutine per manager and a 2 second sweep. It is simpler
than many timers. `Close` can stop the sweeper and wait for it to exit.

The real tradeoff is timer count versus cleanup delay. Approach 1 has one
live `*time.Timer` per session. N sessions means N timers. Many sessions
can expire together and contend for one mutex. The stress test has 20
sessions, so it keeps 20 timers even across 2000 updates per session.

Approach 2 has one goroutine and one ticker. It can keep a stale session
for up to `cleanupInterval` beyond the TTL, here 2s. It fits very high
session counts when the API can call `Close`.

This design does not fit the committed tests. They have no `Close` call.
The sweeper still runs when a fake-clock test returns. `synctest` then
panics.

`check_test.go` has this comment inside `TestSessionManagersCleaner`:
`// Note that the cleaner is only running every 5s`.
`git show HEAD:05-session-cleaner/check_test.go` shows the comment is
older than the `synctest` change. It was written for real `time.Sleep`
calls and a ticker sweeper. It is not a current test rule. Both one-shot
timers fit the current tests. The ticker needs a stop call that the tests
do not have.

## Key takeaways

- Do not remove sessions only on read. A cleaner can check `lastUpdated`
  inside `GetSessionData`. A simple test passes if it reads again. But a
  session nobody reads stays in memory. This defeats the exercise.
- Every path that uses `sessions` needs the same lock. This includes
  `CreateSession`, `GetSessionData`, `UpdateSessionData`, and cleanup.
  Use `sync.Mutex` or `sync.RWMutex`. A cleaner without the lock adds
  another unsafe writer.
- Reuse one `*time.Timer` with `Reset`. Do not replace it. A new timer
  leaves the old one running. Its renewal guard does nothing, and cleanup
  silently stops working.
- `testing/synctest` panics if a goroutine remains after the test. A
  `time.Ticker` loop with no stop causes
  `deadlock: main bubble goroutine has exited but blocked goroutines remain`.
  Use short-lived timers such as `time.AfterFunc`. A persistent worker
  needs an API stop call, and every test must call it.
