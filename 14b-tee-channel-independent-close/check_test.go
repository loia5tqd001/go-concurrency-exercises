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
// This catches rewrites that lose values.
func TestTeeDuplicatesToBothConsumers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		done := make(chan struct{})
		defer close(done)

		in := StartSensor(done, 10)
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

// TestTeeDuplicatesToBothConsumersReversedRoles swaps fast and slow.
// This catches code that treats the first output specially.
func TestTeeDuplicatesToBothConsumersReversedRoles(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		done := make(chan struct{})
		defer close(done)

		in := StartSensor(done, 10)
		out1, out2 := Tee(done, in)

		var fast, slow []int
		var wg sync.WaitGroup

		wg.Add(1)
		go func() {
			defer wg.Done()
			for v := range out2 {
				fast = append(fast, v)
			}
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			for v := range out1 {
				time.Sleep(2 * time.Millisecond)
				slow = append(slow, v)
			}
		}()

		wg.Wait()

		want := expectedSequence(10)

		if !reflect.DeepEqual(fast, want) {
			t.Errorf("fast consumer (out2) got %v, want %v (every value must reach every consumer)", fast, want)
		}
		if !reflect.DeepEqual(slow, want) {
			t.Errorf("slow consumer (out1) got %v, want %v (every value must reach every consumer)", slow, want)
		}
	})
}

// receiveWithTimeout prevents a stuck output from hanging the test.
// The budget uses synctest's fake clock.
func receiveWithTimeout(t *testing.T, ch <-chan int, budget time.Duration) int {
	t.Helper()

	select {
	case v := <-ch:
		return v
	case <-time.After(budget):
		t.Fatalf("no value received within %v - is delivery to this output waiting on some other output being read first?", budget)
		return 0
	}
}

// TestTeeDeliversToOneOutputWithoutWaitingOnTheOther checks send order.
// One output is read once while the other stays untouched.
// Both sends must be ready in the same select.
func TestTeeDeliversToOneOutputWithoutWaitingOnTheOther(t *testing.T) {
	cases := []struct {
		name        string
		firstIsOut1 bool
	}{
		{name: "out1 read first, out2 untouched", firstIsOut1: true},
		{name: "out2 read first, out1 untouched", firstIsOut1: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				done := make(chan struct{})
				defer close(done)

				const n = 3
				in := StartSensor(done, n)
				out1, out2 := Tee(done, in)

				firstOut, otherOut := out1, out2
				if !tc.firstIsOut1 {
					firstOut, otherOut = out2, out1
				}

				budget := 4 * SensorInterval
				got := receiveWithTimeout(t, firstOut, budget)
				if got != 0 {
					t.Fatalf("first value received was %d, want 0", got)
				}

				// Drain both outputs to check correctness.
				want := expectedSequence(n)
				var firstRest, other []int
				var wg sync.WaitGroup

				wg.Add(1)
				go func() {
					defer wg.Done()
					for v := range firstOut {
						firstRest = append(firstRest, v)
					}
				}()

				wg.Add(1)
				go func() {
					defer wg.Done()
					for v := range otherOut {
						other = append(other, v)
					}
				}()

				wg.Wait()

				first := append([]int{got}, firstRest...)
				if !reflect.DeepEqual(first, want) {
					t.Fatalf("first output got %v, want %v", first, want)
				}
				if !reflect.DeepEqual(other, want) {
					t.Fatalf("other output got %v, want %v", other, want)
				}
			})
		})
	}
}

// TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered checks closing order.
// A fast output must close after its last value, even if the other is unread.
// The test runs with each output as the fast one.
// synctest.Wait lets the closing goroutine finish before each check.
func TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered(t *testing.T) {
	cases := []struct {
		name        string
		fastIsFirst bool
	}{
		{name: "out1 is the fast one", fastIsFirst: true},
		{name: "out2 is the fast one", fastIsFirst: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				done := make(chan struct{})
				defer close(done)

				const n = 5
				in := StartSensor(done, n)
				out1, out2 := Tee(done, in)

				fastOut, slowOut := out1, out2
				if !tc.fastIsFirst {
					fastOut, slowOut = out2, out1
				}

				want := expectedSequence(n)

				budget := 4 * SensorInterval
				var fast []int
				for i := 0; i < n; i++ {
					fast = append(fast, receiveWithTimeout(t, fastOut, budget))
				}
				if !reflect.DeepEqual(fast, want) {
					t.Fatalf("fast=%v, want %v (every value should have reached the fast output by now)", fast, want)
				}

				synctest.Wait()
				select {
				case v, ok := <-fastOut:
					if ok {
						t.Fatalf("fast output produced an extra value (%d) it shouldn't have", v)
					}
				default:
					t.Fatalf("fast output should already be closed: every value has been delivered to it, regardless of whether the slow output (never read yet) has caught up")
				}

				var slow []int
				for i := 0; i < n; i++ {
					slow = append(slow, receiveWithTimeout(t, slowOut, budget))
				}
				if !reflect.DeepEqual(slow, want) {
					t.Fatalf("slow=%v, want %v", slow, want)
				}

				synctest.Wait()
				select {
				case v, ok := <-slowOut:
					if ok {
						t.Fatalf("slow output produced an extra value (%d) it shouldn't have", v)
					}
				default:
					t.Fatalf("slow output should already be closed: every value has been delivered to it")
				}
			})
		})
	}
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

// recvRealTimeWithTimeout prevents a stuck read from hanging the test.
// The budget is real time and must exceed SensorInterval.
func recvRealTimeWithTimeout(t *testing.T, ch <-chan int, budget time.Duration) int {
	t.Helper()

	select {
	case v := <-ch:
		return v
	case <-time.After(budget):
		t.Fatalf("no value received within %v - is delivery to this output stalled waiting on the other output?", budget)
		return 0
	}
}

// teeStopsOnDoneOnce reads from both outputs, closes done,
// then checks both outputs close promptly.
// This catches a rewrite that loses done handling.
func teeStopsOnDoneOnce(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	in := StartSensor(done, 50) // far more values than this test will ever consume

	out1, out2 := Tee(done, in)

	// Let both outputs make progress before shutdown.
	const drainBudget = 200 * time.Millisecond
	recvRealTimeWithTimeout(t, out1, drainBudget)
	recvRealTimeWithTimeout(t, out2, drainBudget)
	recvRealTimeWithTimeout(t, out1, drainBudget)
	recvRealTimeWithTimeout(t, out2, drainBudget)

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
