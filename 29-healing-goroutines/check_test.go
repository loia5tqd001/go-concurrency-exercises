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

// TestStewardRestartsWedgedWard checks heartbeat recovery.
// The steward must start more than one ward generation.
func TestStewardRestartsWedgedWard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const (
			pulseInterval     = 100 * time.Millisecond
			timeout           = 350 * time.Millisecond
			pulsesBeforeWedge = 5
			wantPulses        = 12 // more than one generation's worth
		)

		ward := NewMockWard(pulsesBeforeWedge)
		steward := NewSteward(timeout, ward.Start)

		done := make(chan struct{})
		heartbeat := steward(done, pulseInterval)

		received := 0
		deadline := time.After(5 * time.Second)

		for received < wantPulses {
			select {
			case _, ok := <-heartbeat:
				if !ok {
					t.Fatalf("steward's heartbeat channel closed unexpectedly after %d pulse(s)", received)
				}
				received++

			case <-deadline:
				t.Fatalf(
					"timed out after only %d pulse(s); an unsupervised ward would already have gone silent for good after %d pulses (~%v) - the steward does not appear to be restarting it",
					received, pulsesBeforeWedge, time.Duration(pulsesBeforeWedge)*pulseInterval,
				)
			}
		}

		close(done)
		synctest.Wait()

		gensAtShutdown := ward.Generations()
		if gensAtShutdown <= 1 {
			t.Fatalf("expected the steward to have started more than 1 ward generation, got %d - a restart does not appear to have actually happened", gensAtShutdown)
		}

		// Closing done must stop the monitor itself, not one ward only.
		time.Sleep(5 * timeout)
		synctest.Wait()

		if after := ward.Generations(); after != gensAtShutdown {
			t.Fatalf(
				"steward started %d more ward generation(s) after its own done was closed (%d -> %d); closing done must stop it entirely, not just this generation",
				after-gensAtShutdown, gensAtShutdown, after,
			)
		}
	})
}

// TestStewardUsesFreshPerGenerationDone checks each ward's done channel.
// A reused caller done would still pass the restart test.
// This test catches that by checking every recorded done.
func TestStewardUsesFreshPerGenerationDone(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const (
			pulseInterval     = 100 * time.Millisecond
			timeout           = 350 * time.Millisecond
			pulsesBeforeWedge = 5
			wantGenerations   = 3
		)

		ward := NewMockWard(pulsesBeforeWedge)
		steward := NewSteward(timeout, ward.Start)

		done := make(chan struct{})
		heartbeat := steward(done, pulseInterval)

		deadline := time.After(5 * time.Second)
		for ward.Generations() < wantGenerations {
			select {
			case <-heartbeat:
			case <-deadline:
				t.Fatalf(
					"timed out waiting for %d ward generations to start; only %d started",
					wantGenerations, ward.Generations(),
				)
			}
		}

		close(done)
		synctest.Wait()

		dones := ward.Dones()
		if len(dones) < wantGenerations {
			t.Fatalf("expected at least %d recorded generation(s), got %d", wantGenerations, len(dones))
		}

		for i, d := range dones {
			if d == done {
				t.Fatalf(
					"generation %d was started with the steward's own incoming done instead of a fresh, steward-owned wardDone",
					i+1,
				)
			}
		}

		for i := 1; i < len(dones); i++ {
			if dones[i] == dones[i-1] {
				t.Fatalf(
					"generation %d was started with the same done channel as generation %d - each generation must get its own fresh wardDone",
					i+1, i,
				)
			}
		}

		for i, d := range dones {
			select {
			case <-d:
			default:
				t.Errorf("generation %d's wardDone is still open after the steward stopped; abandoned and stopped generations must be told to exit", i+1)
			}
		}
	})
}

// TestStewardKeepsMonitoringWithoutAReader checks a slow caller.
// A blocking heartbeat send must not stop restarts.
func TestStewardKeepsMonitoringWithoutAReader(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const (
			pulseInterval     = 100 * time.Millisecond
			timeout           = 350 * time.Millisecond
			pulsesBeforeWedge = 1
		)

		ward := NewMockWard(pulsesBeforeWedge)
		steward := NewSteward(timeout, ward.Start)

		done := make(chan struct{})
		_ = steward(done, pulseInterval)

		// Do not read heartbeats while the steward monitors.
		time.Sleep(2 * timeout)
		if gens := ward.Generations(); gens < 2 {
			t.Fatalf("steward started %d ward generation(s) with no heartbeat reader, want at least 2 - forwarding a heartbeat appears to block the monitor loop", gens)
		}

		close(done)
		synctest.Wait()
	})
}

// TestStewardStopsOnDone checks shutdown and healthy behavior.
// Shutdown must not hang.
// A healthy ward must never restart.
func TestStewardStopsOnDone(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const (
			pulseInterval     = 50 * time.Millisecond
			timeout           = 500 * time.Millisecond
			pulsesBeforeWedge = 1000 // effectively never wedges in this test
			healthyPulses     = 40   // 40 * 50ms = 2s, 4x the timeout
		)

		ward := NewMockWard(pulsesBeforeWedge)
		steward := NewSteward(timeout, ward.Start)

		done := make(chan struct{})
		heartbeat := steward(done, pulseInterval)

		// Read well past several timeout windows.
		// Every pulse should reset the stall timer.
		for i := 0; i < healthyPulses; i++ {
			select {
			case <-heartbeat:
			case <-time.After(2 * time.Second):
				t.Fatalf("timed out waiting for pulse %d from a healthy ward", i+1)
			}
		}

		if gens := ward.Generations(); gens != 1 {
			t.Fatalf(
				"expected exactly 1 ward generation after %d pulses from a ward that never stalled, got %d - the steward appears to be restarting unconditionally rather than only on an actual stall",
				healthyPulses, gens,
			)
		}

		close(done)
		synctest.Wait()

		dones := ward.Dones()
		if len(dones) != 1 {
			t.Fatalf("expected 1 recorded generation, got %d", len(dones))
		}
		select {
		case <-dones[0]:
		default:
			t.Error("active generation's wardDone is still open after the steward's own done closed")
		}

		// No pulse should arrive after done closes.
		select {
		case _, ok := <-heartbeat:
			if ok {
				t.Fatalf("received a pulse after closing done; steward should have stopped sending")
			}
			// Closing heartbeat on shutdown is allowed but optional.
		case <-time.After(2 * time.Second):
			// No pulse and no close is fine too.
		}
	})
}
