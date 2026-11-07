//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// These two tests finish every goroutine before they return.
// FastProcessCompletes stops inside the quota.
// PremiumUser_NeverKilled waits for process without a timeout.
// Both can use synctest's fake clock safely.

func TestHandleRequest_FreeUser_FastProcessCompletes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		u := &User{ID: 1, IsPremium: false}
		done := false
		process := func() {
			time.Sleep(1 * time.Second)
			done = true
		}

		if ok := HandleRequest(process, u); !ok {
			t.Error("expected free user's process under 10s to complete, but it was killed")
		}
		if !done {
			t.Error("expected process to have run to completion")
		}
	})
}

func TestHandleRequest_PremiumUser_NeverKilled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		u := &User{ID: 3, IsPremium: true}
		done := false
		process := func() {
			time.Sleep(11 * time.Second)
			done = true
		}

		if ok := HandleRequest(process, u); !ok {
			t.Error("expected premium user's process to never be killed regardless of duration")
		}
		if !done {
			t.Error("expected process to have run to completion")
		}
	})
}

// Tests below kill process while it still runs.
// Go cannot force a goroutine to stop.
// HandleRequest therefore leaves a sleeping goroutine behind.
// synctest stops fake time when the test returns.
// A sleeping goroutine then looks like a deadlock.
// Keep these tests on the real clock.

func TestHandleRequest_FreeUser_SlowProcessKilled(t *testing.T) {
	t.Parallel()
	u := &User{ID: 2, IsPremium: false}
	process := func() {
		time.Sleep(11 * time.Second)
	}

	if ok := HandleRequest(process, u); ok {
		t.Error("expected free user's process over 10s to be killed")
	}
}

// Advanced level: free quota accumulates across requests.

func TestHandleRequest_FreeUser_AccumulatedTimeExceeded(t *testing.T) {
	t.Parallel()
	u := &User{ID: 4, IsPremium: false}

	// Use 4s of the 10s quota.
	if ok := HandleRequest(func() { time.Sleep(4 * time.Second) }, u); !ok {
		t.Fatal("expected first 4s request to succeed")
	}

	// Use another 4s, for 8s total.
	if ok := HandleRequest(func() { time.Sleep(4 * time.Second) }, u); !ok {
		t.Fatal("expected second 4s request to succeed")
	}

	// Only 2s remains, so this 4s request should stop after 2s.
	start := time.Now()
	if ok := HandleRequest(func() { time.Sleep(4 * time.Second) }, u); ok {
		t.Error("expected third request to be killed once accumulated quota is exceeded")
	}
	if elapsed := time.Since(start); elapsed < 1*time.Second || elapsed > 3*time.Second {
		t.Errorf("expected request to be killed ~2s in, took %v", elapsed)
	}

	// The quota is gone. Kill the next request immediately.
	start = time.Now()
	if ok := HandleRequest(func() { time.Sleep(1 * time.Second) }, u); ok {
		t.Error("expected request to be killed immediately once quota is fully used")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Errorf("expected immediate kill with no quota left, took %v", elapsed)
	}
}

func TestHandleRequest_FreeUser_QuotaIsPerUser(t *testing.T) {
	t.Parallel()
	u1 := &User{ID: 5, IsPremium: false}
	u2 := &User{ID: 6, IsPremium: false}

	// Use 5s for u1, then start a 6s request with only 5s left.
	if ok := HandleRequest(func() { time.Sleep(5 * time.Second) }, u1); !ok {
		t.Fatal("expected u1's first 5s request to succeed")
	}
	if ok := HandleRequest(func() { time.Sleep(6 * time.Second) }, u1); ok {
		t.Error("expected u1's second request to be killed once its quota is exceeded")
	}

	// u2 still has the full quota.
	if ok := HandleRequest(func() { time.Sleep(3 * time.Second) }, u2); !ok {
		t.Error("expected u2's quota to be independent of u1's usage")
	}
}

// These tests send concurrent requests for one free user.
// They need real mutex contention while one request sleeps.
// synctest does not advance while a goroutine waits on sync.Mutex.
// The fake clock could hang, so keep these tests on the real clock.

func TestHandleRequest_FreeUser_ConcurrentRequestsDoNotDoubleSpendQuota(t *testing.T) {
	t.Parallel()
	u := &User{ID: 7, IsPremium: false}

	// Two 6s requests need 12s from a 10s quota.
	// Only one request may succeed.
	// Checking and reserving quota must happen as one step.
	// Otherwise both requests can see the same free quota.
	const concurrentRequests = 2
	results := make([]bool, concurrentRequests)
	var wg sync.WaitGroup
	for i := 0; i < concurrentRequests; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = HandleRequest(func() { time.Sleep(6 * time.Second) }, u)
		}(i)
	}
	wg.Wait()

	succeeded := 0
	for _, ok := range results {
		if ok {
			succeeded++
		}
	}
	if succeeded >= concurrentRequests {
		t.Errorf("expected at most one of %d concurrent 6s requests to succeed on a 10s quota, got %d succeed (results=%v, TimeUsed=%v)",
			concurrentRequests, succeeded, results, u.TimeUsed)
	}
}

// This test checks that a later request uses the first request's real usage.
// Reserving all remaining quota upfront would reject the second request.
// The first request uses only 1s, so the second should still succeed.
// A correct design waits for the actual usage.
func TestHandleRequest_FreeUser_ConcurrentRequestNotRejectedOnEarlierEarlyFinish(t *testing.T) {
	t.Parallel()
	u := &User{ID: 9, IsPremium: false}

	var wg sync.WaitGroup
	var firstOK, secondOK bool

	wg.Add(1)
	go func() {
		defer wg.Done()
		firstOK = HandleRequest(func() { time.Sleep(1 * time.Second) }, u)
	}()

	// Start the second request while the first is still running.
	time.Sleep(200 * time.Millisecond)

	wg.Add(1)
	go func() {
		defer wg.Done()
		secondOK = HandleRequest(func() { time.Sleep(2 * time.Second) }, u)
	}()

	wg.Wait()

	if !firstOK {
		t.Fatal("expected the first 1s request to succeed")
	}
	if !secondOK {
		t.Error("expected the second request to succeed once the first's actual (short) usage is known - " +
			"1s + 2s is well within the 10s quota, so rejecting it means the decision was made on a worst-case " +
			"guess instead of the first request's real, now-known usage")
	}
}
