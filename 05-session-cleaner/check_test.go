package main

import (
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestSessionManagersCreationAndUpdate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := NewSessionManager()
		sID, err := m.CreateSession()
		if err != nil {
			t.Error("Error CreateSession:", err)
		}

		data, err := m.GetSessionData(sID)
		if err != nil {
			t.Error("Error GetSessionData:", err)
		}

		data["website"] = "longhoang.de"
		err = m.UpdateSessionData(sID, data)
		if err != nil {
			t.Error("Error UpdateSessionData:", err)
		}

		data, err = m.GetSessionData(sID)
		if err != nil {
			t.Error("Error GetSessionData:", err)
		}

		if data["website"] != "longhoang.de" {
			t.Error("Expected website to be longhoang.de")
		}
	})
}

func TestSessionManagersCleaner(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := NewSessionManager()
		sID, err := m.CreateSession()
		if err != nil {
			t.Error("Error CreateSession:", err)
		}

		// The cleaner runs every 5s.
		time.Sleep(7 * time.Second)
		_, err = m.GetSessionData(sID)
		if err != ErrSessionNotFound {
			t.Error("Session still in memory after 7 seconds")
		}
	})
}

func TestSessionManagersCleanerAfterUpdate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := NewSessionManager()
		sID, err := m.CreateSession()
		if err != nil {
			t.Error("Error CreateSession:", err)
		}

		time.Sleep(3 * time.Second)

		err = m.UpdateSessionData(sID, make(map[string]interface{}))
		if err != nil {
			t.Error("Error UpdateSessionData:", err)
		}

		time.Sleep(3 * time.Second)

		_, err = m.GetSessionData(sID)
		if err == ErrSessionNotFound {
			t.Error("Session not found although has been updated 3 seconds earlier.")
		}

		time.Sleep(4 * time.Second)
		_, err = m.GetSessionData(sID)
		if err != ErrSessionNotFound {
			t.Error("Session still in memory 7 seconds after update")
		}
	})
}

// TestSessionManagerConcurrentAccess calls all manager methods at once.
// The race detector can then find unsynchronized map access.
// This test uses the real clock, not synctest.
// The goroutines never block, so fake time would not advance.
// A fixed loop count keeps the test deterministic.
func TestSessionManagerConcurrentAccess(t *testing.T) {
	m := NewSessionManager()

	const numSessions = 20
	const iterationsPerGoroutine = 2000
	sessionIDs := make([]string, numSessions)
	for i := range sessionIDs {
		sID, err := m.CreateSession()
		if err != nil {
			t.Fatal("Error CreateSession:", err)
		}
		sessionIDs[i] = sID
	}

	var wg sync.WaitGroup

	for _, sID := range sessionIDs {
		sID := sID

		wg.Add(3)

		go func() {
			defer wg.Done()
			for i := 0; i < iterationsPerGoroutine; i++ {
				_, _ = m.GetSessionData(sID)
			}
		}()

		go func() {
			defer wg.Done()
			for i := 0; i < iterationsPerGoroutine; i++ {
				_ = m.UpdateSessionData(sID, make(map[string]interface{}))
			}
		}()

		go func() {
			defer wg.Done()
			for i := 0; i < iterationsPerGoroutine; i++ {
				_, _ = m.CreateSession()
			}
		}()
	}

	wg.Wait()
}
