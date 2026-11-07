//////////////////////////////////////////////////////////////////////
//
// SessionManager keeps sessions in memory.
// New sessions keep growing until the program runs out of memory.
//
// Add a cleaner that removes sessions after 5 seconds without updates.
// A session should disappear between 5 and 7 seconds.
//
// Protect all session data from races.
//
// Tests use synctest's fake clock.
// Every started goroutine must exit before the test returns.
//

package main

import (
	"errors"
	"log"
)

// SessionManager stores sessions and their update times.
type SessionManager struct {
	sessions map[string]Session
}

// Session stores data for one session.
type Session struct {
	Data map[string]interface{}
}

// NewSessionManager creates an empty session manager.
func NewSessionManager() *SessionManager {
	m := &SessionManager{
		sessions: make(map[string]Session),
	}

	return m
}

// CreateSession stores a new session and returns its ID.
func (m *SessionManager) CreateSession() (string, error) {
	sessionID, err := MakeSessionID()
	if err != nil {
		return "", err
	}

	m.sessions[sessionID] = Session{
		Data: make(map[string]interface{}),
	}

	return sessionID, nil
}

// ErrSessionNotFound means the session ID is unknown.
var ErrSessionNotFound = errors.New("SessionID does not exists")

// GetSessionData returns a session's data or an error.
func (m *SessionManager) GetSessionData(sessionID string) (map[string]interface{}, error) {
	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return session.Data, nil
}

// UpdateSessionData replaces a session's data.
func (m *SessionManager) UpdateSessionData(sessionID string, data map[string]interface{}) error {
	_, ok := m.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}

	// Hint: renew the session expiry here.
	m.sessions[sessionID] = Session{
		Data: data,
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

	err = m.UpdateSessionData(sID, data)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Update session data, set website to longhoang.de")

	updatedData, err := m.GetSessionData(sID)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Get session data:", updatedData)
}
