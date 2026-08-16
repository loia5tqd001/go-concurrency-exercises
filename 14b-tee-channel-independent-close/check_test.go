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

// expectedSequence returns the sequence of readings StartSensor(n) is
// expected to emit: 0, 1, ..., n-1.
func expectedSequence(n int) []int {
	seq := make([]int, n)
	for i := range seq {
		seq[i] = i
	}

	return seq
}

// TestTeeDuplicatesToBothConsumers is the key test: it proves that
// EVERY value produced by `in` reaches BOTH outputs, even when one
// consumer reads much slower than the other. One goroutine drains its
// output as fast as possible; the other sleeps 2ms between reads to
// simulate a slow consumer. Wrapping the whole thing in synctest.Test
// makes the artificial sleep (and StartSensor's internal 5ms sleeps)
// resolve on a fake, deterministic clock instead of the real one, so
// the test is fast and doesn't flake under load.
//
// This is a regression check inherited from 14, not a probe for this
// exercise's own bug: the given starting `Tee` already duplicates
// correctly (that part of 14 is solved), so this passes before you've
// changed a line. It exists to catch a rewrite that loses values while
// restructuring delivery to make closing independent - e.g. an
// implementation that shares one channel between the two outputs, or
// drops a value for whichever output is read second - which would
// leave at least one of the two slices below missing values.
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

// TestTeeDuplicatesToBothConsumersReversedRoles is
// TestTeeDuplicatesToBothConsumers with the fast/slow roles swapped:
// out2 drains as fast as possible and out1 is the one sleeping 2ms
// between reads. Plain duplication shouldn't care which of the two
// output channels happens to be read quickly - an implementation that
// (say) special-cases index 0 somewhere in its fan-out logic instead
// of treating both outputs identically could pass the first test while
// failing this one. This test only checks delivery, not closing
// behavior - see TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered for
// the stricter, independent-closing requirement.
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

// receiveWithTimeout reads one value from ch, failing the test with a
// clear diagnostic instead of hanging forever (and, inside
// synctest.Test, instead of the whole test binary panicking with an
// opaque "deadlock: all goroutines in bubble are blocked" that also
// aborts every other test in the package) if nothing arrives within
// budget. budget is spent on synctest's fake clock here, so a healthy
// Tee - which should deliver near-instantly - burns through none of
// it, while a Tee stuck waiting on some other output reliably times
// out instead of hanging.
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

// TestTeeDeliversToOneOutputWithoutWaitingOnTheOther proves the part
// of the exercise's instructions that TestTeeDuplicatesToBothConsumers
// (and its reversed-roles sibling) can't catch: delivering a value to
// one output must never require the other output to have been read
// at all - not even once - because the two sends for a given value
// have to race in a single select, not be attempted in a fixed order.
//
// The duplication tests use a consumer that sleeps 2ms between reads
// to simulate "slow," but it still reads continuously - so a Tee that
// tries out[0] first and only attempts out[1] once out[0]'s send
// succeeds still passes those tests, just with (fake-clock, so
// invisible there) extra latency on out[1]. This test closes that gap
// directly: it reads only the very first value from one output while
// the other is left completely untouched, with a bounded budget so a
// Tee that's actually waiting on the fixed order times out with a
// clear message instead of hanging. It only checks this for the first
// value, then switches to draining both outputs concurrently for the
// rest - deliberately not requiring a fast consumer to race arbitrarily
// far ahead of a completely unread one, since that's a stronger,
// separate property already covered by
// TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered.
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

				// Now drain both outputs concurrently for the rest -
				// this part is just a correctness check, not a probe
				// for the fixed-order bug.
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

// TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered proves that
// out1 and out2 close independently of each other: the moment every
// value has reached a given output, that output closes right away -
// even if the other one is still sitting on a large backlog because
// its consumer hasn't read anything yet. A Tee that only closes both
// outputs together (gated on the SLOWEST consumer) would fail this:
// the fast output would still be open when checked below, since the
// slow one hasn't been touched at all yet.
//
// It runs the scenario from both directions - out1 fast/out2 slow,
// AND out2 fast/out1 slow - as subtests. This is deliberate: an
// implementation could special-case index 0 (e.g. hard-code out[0]
// or wg[0] somewhere instead of looping generically over both
// outputs) and still pass a version of this test that only ever
// drains out1 first. Running it in both orders catches that
// asymmetry regardless of which index the bug favors.
//
// Both outputs are drained with ordinary sequential receives (no
// second goroutine, nothing for -race to complain about), each bounded
// by receiveWithTimeout: a Tee whose per-value fan-out is
// order-dependent (see TestTeeDeliversToOneOutputWithoutWaitingOnTheOther)
// would otherwise leave the fast output's drain loop waiting on the
// untouched slow output, and receiveWithTimeout's t.Fatalf reports that
// cleanly and fails just this subtest - it doesn't hang, and (because
// StartSensor itself also honors `done`, closed by this test's own
// defer, so it can always unwind rather than being left blocked
// forever trying to feed a `Tee` that's stopped reading) it doesn't
// crash the rest of the suite either. Once the fast output's drain
// completes, every value the sensor will ever produce has already
// reached it - there is no future send that could still target it -
// so it must be free to close immediately, independent of the other
// output. A synctest.Wait() is used before checking: closing an output
// happens on a background goroutine reacting to the last delivery,
// which needs a chance to run; Wait() is the right tool here because
// it's confirming something that has already been triggered has
// finished, not asking the fake clock to advance through unrelated
// future timers. The slow output is then drained (and its own prompt
// close confirmed) the same bounded way, now that the independent-close
// property being tested no longer requires leaving it untouched.
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

// assertClosesPromptly reads once from ch and fails unless it observes
// ch already closed within a short, real-time safety-net window. It is
// used to detect a Tee that ignores `done` and keeps its outputs open
// (or keeps delivering stale values) instead of shutting down.
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

// recvRealTimeWithTimeout reads one value from ch on the real clock,
// failing the test with a clear diagnostic instead of hanging toward
// Go's default 10-minute test timeout if nothing arrives within budget.
// This is the real-clock counterpart to receiveWithTimeout above: it's
// used outside synctest.Test, where there's no fake clock to burn -
// budget is real wall-clock time, so it must comfortably exceed
// SensorInterval, not just a few multiples of it.
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

// teeStopsOnDoneOnce wires Tee up to a sensor that produces far more
// values than the test will ever consume, reads a couple of full
// rounds from both outputs, closes done, and asserts that both outputs
// close promptly afterwards instead of continuing to deliver values or
// hanging forever.
//
// This is a regression check inherited from 14, not a probe for this
// exercise's own bug: the given starting `Tee` already abandons both
// outputs and closes them the moment `done` fires (that part of 14 is
// solved). It exists to catch a rewrite that, while restructuring
// delivery to make closing independent, drops or narrows the `done`
// handling - e.g. only checking `done` in one of the two now-separate
// per-output delivery paths, so the other one keeps sending stale
// values or never closes.
//
// Each of the initial drain reads is bounded by recvRealTimeWithTimeout
// rather than a bare receive: an independent-delivery Tee that's
// subtly wrong (e.g. one output's fan-out goroutine stalls under some
// interleaving) could otherwise hang this test - and every test that
// shares this helper - toward the default 10-minute timeout instead of
// failing fast with a diagnostic.
func teeStopsOnDoneOnce(t *testing.T) {
	t.Helper()

	done := make(chan struct{})
	in := StartSensor(done, 50) // far more values than this test will ever consume

	out1, out2 := Tee(done, in)

	// Drain a couple of full rounds so both outputs have made progress
	// before we ask everything to shut down.
	const drainBudget = 200 * time.Millisecond
	recvRealTimeWithTimeout(t, out1, drainBudget)
	recvRealTimeWithTimeout(t, out2, drainBudget)
	recvRealTimeWithTimeout(t, out1, drainBudget)
	recvRealTimeWithTimeout(t, out2, drainBudget)

	close(done)

	assertClosesPromptly(t, out1, "out1")
	assertClosesPromptly(t, out2, "out2")
}

// TestTeeStopsOnDone checks that closing done causes Tee to stop
// promptly, closing both of its output channels rather than hanging
// onto them (or the goroutine feeding them) forever.
func TestTeeStopsOnDone(t *testing.T) {
	teeStopsOnDoneOnce(t)
}

// TestTeeStopsOnDoneRace repeats the shutdown scenario a number of
// times so that, run with `go test -race`, it has a reasonable chance
// of catching a data race in a select-based shutdown path that only
// shows up under contention.
func TestTeeStopsOnDoneRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		teeStopsOnDoneOnce(t)
	}
}
