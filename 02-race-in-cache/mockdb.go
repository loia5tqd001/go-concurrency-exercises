//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync/atomic"
	"time"
)

// MockDB simulates a database.
type MockDB struct {
	Calls int32
}

// Get waits, then returns the key.
func (db *MockDB) Get(key string) (string, error) {
	d, _ := time.ParseDuration("20ms")
	time.Sleep(d)
	atomic.AddInt32(&db.Calls, 1)
	return key, nil
}

// GetMockDB returns an empty MockDB.
func GetMockDB() *MockDB {
	return &MockDB{
		Calls: 0,
	}
}
