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

// mainTimeout bounds the whole test. A correct solution rate-limits to
// 1 fetch/sec and this crawl makes ~13 fetches (depth 4 from
// http://golang.org/), so it legitimately takes ~13s - measured at
// 13.00s against a correct reference fix. A solution that deadlocks
// (e.g. a mutex or WaitGroup misused while adding the rate limit)
// would otherwise hang toward Go's default 10-minute test timeout
// instead of failing fast.
const mainTimeout = 30 * time.Second

func TestMain(t *testing.T) {
	fetchSig := fetchSignalInstance()

	// violation carries the "too fast" message out of the checker
	// goroutine below. t.Fatal/t.FailNow may only be called from the
	// goroutine running the test itself, so the checker reports over a
	// channel instead of failing the test directly.
	violation := make(chan string, 1)
	go func(start time.Time) {
		for range fetchSig {
			// Check if signal arrived earlier than a second (with error margin)
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
		// main() returned with no timing violation observed - solution is correct.
	case <-time.After(mainTimeout):
		t.Fatalf("main() did not finish within %s - the solution likely deadlocks", mainTimeout)
	}
}
