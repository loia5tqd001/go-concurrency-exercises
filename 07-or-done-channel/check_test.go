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

// TestOrDoneForwardsValues checks that orDone still does its one job
// while done stays open: values read from the wrapped channel must be
// the same sequential, increasing values StartMetricStream emits.
// This passes against both the naive passthrough and a correct
// implementation.
func TestOrDoneForwardsValues(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	out := orDone(done, StartMetricStream())

	var got []int
	for i := 0; i < 5; i++ {
		v, ok := <-out
		if !ok {
			t.Fatalf("out closed early after %d value(s), want at least 5", i)
		}
		got = append(got, v)
	}

	for i := 1; i < len(got); i++ {
		if got[i] != got[i-1]+1 {
			t.Fatalf("expected sequential increasing values, got %v", got)
		}
	}
}

// orDoneStopsPromptly is the shared body of the "does orDone actually
// stop leaking" check: it wires orDone up to a channel that will
// never receive a value (so any unconditional read on it blocks
// forever), starts a goroutine that tries to read from the wrapped
// channel, closes done, and then asserts - via a short, real-time
// safety-net timeout - that the wrapped channel closes promptly
// instead of the reader hanging forever.
//
// c is never written to, so the only way `out` can produce anything
// is by observing done and closing itself. Against the naive
// passthrough (`return c`), out IS c: closing done does nothing to
// it, nobody ever sends on c, and the read below hangs until the
// safety-net timeout fires - which is exactly the leak this exercise
// is about.
func orDoneStopsPromptly(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	c := make(chan int) // never written to: an unconditional read blocks forever

	out := orDone(done, c)

	result := make(chan bool, 1)
	go func() {
		_, ok := <-out
		result <- ok
	}()

	close(done)

	select {
	case ok := <-result:
		if ok {
			t.Errorf("expected out to be closed (ok == false) once done fires, got a value instead")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("orDone did not stop promptly after done was closed - the forwarding goroutine appears to be leaked, blocked forever on a receive/send that will never happen")
	}
}

// TestOrDoneStopsPromptlyOnDone is the key test: it proves that
// closing done actually unblocks and shuts down orDone's forwarding
// goroutine, rather than leaving it stuck forever.
func TestOrDoneStopsPromptlyOnDone(t *testing.T) {
	orDoneStopsPromptly(t)
}

// TestOrDoneNoGoroutineLeakRace repeats the shutdown scenario a
// number of times so that, run with `go test -race`, it has a
// reasonable chance of catching a data race in a select-based
// shutdown path that only shows up under contention.
func TestOrDoneNoGoroutineLeakRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		orDoneStopsPromptly(t)
	}
}
