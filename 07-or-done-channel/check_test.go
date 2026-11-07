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

// TestOrDoneForwardsValues checks values pass through in order.
// This runs while done stays open.
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

// orDoneStopsPromptly checks that closing done closes out.
// The input never sends, so a plain receive would block forever.
// The timeout turns a leaked goroutine into a clear test failure.
func orDoneStopsPromptly(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	c := make(chan int) // no sends occur

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

// TestOrDoneStopsPromptlyOnDone checks that closing done closes out.
func TestOrDoneStopsPromptlyOnDone(t *testing.T) {
	orDoneStopsPromptly(t)
}

// TestOrDoneNoGoroutineLeakRace repeats shutdown to expose race bugs.
func TestOrDoneNoGoroutineLeakRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		orDoneStopsPromptly(t)
	}
}

// orDoneStopsPromptlyMidForward checks a send that is already in progress.
// A solution that guards only the receive will fail here.
// It will send a stale value after done closes.
func orDoneStopsPromptlyMidForward(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	c := make(chan int)

	go func() {
		v := 0
		for {
			v++
			select {
			case c <- v:
			case <-done:
				return
			}
		}
	}()

	out := orDone(done, c)

	<-out
	time.Sleep(20 * time.Millisecond)

	close(done)

	select {
	case v, ok := <-out:
		if ok {
			t.Errorf("expected out to be closed (ok == false) once done fires, got stale value %d instead - the forwarding send must also select on done", v)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("orDone did not stop promptly after done was closed - the forwarding goroutine appears to be leaked, blocked on a send that will never be read")
	}
}

// TestOrDoneStopsPromptlyMidForward checks shutdown during a send.
func TestOrDoneStopsPromptlyMidForward(t *testing.T) {
	orDoneStopsPromptlyMidForward(t)
}

// TestOrDoneNoGoroutineLeakMidForwardRace repeats shutdown to expose race bugs.
func TestOrDoneNoGoroutineLeakMidForwardRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		orDoneStopsPromptlyMidForward(t)
	}
}
