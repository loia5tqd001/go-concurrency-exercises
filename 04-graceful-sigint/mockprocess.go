//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// MockProcess simulates a process and its running state.
type MockProcess struct {
	mu        sync.Mutex
	isRunning bool
}

// Run marks the process as running, then loops forever.
func (m *MockProcess) Run() {
	m.mu.Lock()
	m.isRunning = true
	m.mu.Unlock()

	fmt.Print("Process running..")
	for {
		fmt.Print(".")
		time.Sleep(1 * time.Second)
	}
}

// Stop simulates a graceful stop, but never returns in this mock.
func (m *MockProcess) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.isRunning {
		log.Fatal("Cannot stop a process which is not running")
	}

	fmt.Print("\nStopping process..")
	for {
		fmt.Print(".")
		time.Sleep(1 * time.Second)
	}
}
