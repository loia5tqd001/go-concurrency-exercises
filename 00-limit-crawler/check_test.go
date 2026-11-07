//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"testing"
	"time"
)

// mainTimeout bounds the whole test.
// A correct solution limits fetches to one per second.
// This crawl makes about 13 fetches, so it needs about 13 seconds.
// The limit lets a deadlocked solution fail quickly.
const mainTimeout = 30 * time.Second

func TestMain(t *testing.T) {
	fetchSig := fetchSignalInstance()

	// violation carries a timing error from the checker goroutine.
	// t.Fatal may only run in the test goroutine.
	// The checker reports through this channel instead.
	violation := make(chan string, 1)
	go func(start time.Time) {
		for range fetchSig {
			// Fail if two fetches are less than one second apart.
			if time.Since(start) < 950*time.Millisecond {
				select {
				case violation <- "There exists a two crawls that were executed less than 1 second apart.":
				default:
				}
				return
			}
			start = time.Now()
		}
	}(time.Unix(0, 0))

	done := make(chan struct{})
	go func() {
		main()
		close(done)
	}()

	select {
	case msg := <-violation:
		t.Log(msg)
		t.Fatal("Solution is incorrect.")
	case <-done:
		// main returned without a timing error.
	case <-time.After(mainTimeout):
		t.Fatalf("main() did not finish within %s - the solution likely deadlocks", mainTimeout)
	}
}
