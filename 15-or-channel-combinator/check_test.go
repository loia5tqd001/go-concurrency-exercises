//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"testing"
	"testing/synctest"
	"time"
)

// makeSignalChannels returns n open signal channels.
func makeSignalChannels(n int) []chan struct{} {
	chans := make([]chan struct{}, n)
	for i := range chans {
		chans[i] = make(chan struct{})
	}

	return chans
}

// asReadOnly makes the slice accept read-only channels.
func asReadOnly(chans []chan struct{}) []<-chan struct{} {
	ro := make([]<-chan struct{}, len(chans))
	for i, c := range chans {
		ro[i] = c
	}

	return ro
}

// TestOrFiresOnAnyChannel closes a channel in the middle of the slice.
// A real clock and timeout keep a broken version from crashing synctest.
func TestOrFiresOnAnyChannel(t *testing.T) {
	chans := makeSignalChannels(5)

	go func() {
		time.Sleep(50 * time.Millisecond)
		close(chans[3])
	}()

	start := time.Now()
	combined := or(asReadOnly(chans)...)

	select {
	case <-combined:
		elapsed := time.Since(start)
		if elapsed >= 300*time.Millisecond {
			t.Errorf("or() took %s to fire after ch3 closed at ~50ms; "+
				"want well under 300ms - looks like or() isn't watching "+
				"every channel it was given", elapsed)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("or() did not fire within 300ms after channels[3] closed - " +
			"looks like or() isn't watching every channel it was given (only channels[0]?)")
	}
}

// TestOrFiresOnFirstChannel checks the naive version's only working case.
func TestOrFiresOnFirstChannel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		chans := makeSignalChannels(4)

		go func() {
			time.Sleep(30 * time.Millisecond)
			close(chans[0])
		}()

		start := time.Now()
		combined := or(asReadOnly(chans)...)
		<-combined
		elapsed := time.Since(start)

		if elapsed >= 100*time.Millisecond {
			t.Errorf("or() took %s to fire after ch0 closed at ~30ms; want well under 100ms", elapsed)
		}
	})
}

// TestOrHandlesManyChannels checks a signal from the middle of 20 inputs.
// A real clock and timeout handle a broken implementation cleanly.
func TestOrHandlesManyChannels(t *testing.T) {
	const n = 20
	const closeIndex = 12

	chans := makeSignalChannels(n)

	go func() {
		time.Sleep(40 * time.Millisecond)
		close(chans[closeIndex])
	}()

	start := time.Now()
	combined := or(asReadOnly(chans)...)

	select {
	case <-combined:
		elapsed := time.Since(start)
		if elapsed >= 300*time.Millisecond {
			t.Errorf("or() with %d channels took %s to fire after channels[%d] closed at ~40ms; "+
				"want well under 300ms", n, elapsed, closeIndex)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatalf("or() with %d channels did not fire within 300ms after channels[%d] closed", n, closeIndex)
	}
}

// TestOrHandlesEdgeCases checks zero inputs and one input.
func TestOrHandlesEdgeCases(t *testing.T) {
	t.Run("zero channels", func(t *testing.T) {
		combined := or()
		if combined == nil {
			t.Fatal("or() with no channels returned a nil channel")
		}

		select {
		case <-combined:
			t.Error("or() with no input channels closed on its own; it should never close")
		case <-time.After(20 * time.Millisecond):
			// Expected: there is nothing to close it.
		}
	})

	t.Run("one channel", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			ch := make(chan struct{})

			go func() {
				time.Sleep(20 * time.Millisecond)
				close(ch)
			}()

			start := time.Now()
			combined := or(ch)
			<-combined
			elapsed := time.Since(start)

			if elapsed >= 100*time.Millisecond {
				t.Errorf("or() with a single channel took %s to fire after it closed at ~20ms; "+
					"want well under 100ms", elapsed)
			}
		})
	})
}
