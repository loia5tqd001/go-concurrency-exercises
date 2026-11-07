//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"reflect"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// expectedSequence returns 0 through n-1.
func expectedSequence(n int) []int {
	seq := make([]int, n)
	for i := range seq {
		seq[i] = i
	}

	return seq
}

// TestTeeDuplicatesToBothConsumers checks a fast and slow consumer.
// Both outputs must contain every value.
func TestTeeDuplicatesToBothConsumers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		done := make(chan struct{})
		defer close(done)

		in := StartSensor(10)
		out1, out2 := Tee(done, in)

		var fast, slow []int
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			for v := range out1 {
				fast = append(fast, v)
			}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			for v := range out2 {
				time.Sleep(2 * time.Millisecond)
				slow = append(slow, v)
			}
		}()

		wg.Wait()

		want := expectedSequence(10)

		if !reflect.DeepEqual(fast, want) {
			t.Errorf("fast consumer got %v, want %v (every value must reach every consumer)", fast, want)
		}
		if !reflect.DeepEqual(slow, want) {
			t.Errorf("slow consumer got %v, want %v (every value must reach every consumer)", slow, want)
		}
	})
}

// assertClosesPromptly fails if ch delivers a value or stays open.
func assertClosesPromptly(t *testing.T, ch <-chan int, name string) {
	t.Helper()

	select {
	case v, ok := <-ch:
		if ok {
			t.Fatalf("expected %s to be closed once done fires, got value %d instead", name, v)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatalf("%s did not close promptly after done was closed", name)
	}
}

// teeStopsOnDoneOnce reads from both outputs, closes done,
// then checks both outputs close promptly.
func teeStopsOnDoneOnce(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	in := StartSensor(50) // far more values than this test will ever consume

	out1, out2 := Tee(done, in)

	// Let both outputs make progress before shutdown.
	<-out1
	<-out2
	<-out1
	<-out2

	close(done)

	assertClosesPromptly(t, out1, "out1")
	assertClosesPromptly(t, out2, "out2")
}

// TestTeeStopsOnDone checks both outputs close after done.
func TestTeeStopsOnDone(t *testing.T) {
	teeStopsOnDoneOnce(t)
}

// TestTeeStopsOnDoneRace repeats shutdown to expose races.
func TestTeeStopsOnDoneRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		teeStopsOnDoneOnce(t)
	}
}
