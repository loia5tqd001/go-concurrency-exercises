//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"hash/fnv"
	"sync"
	"testing"
)

// expectedResult mirrors the (deterministic) result-generation logic
// in Call, without paying for the simulated latency, so tests can
// check correctness cheaply.
func expectedResult(key string) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))

	return int(h.Sum64() % 1_000_000)
}

// TestDoReturnsCorrectResult checks that a single, uncontended Do call
// returns the same deterministic value Call would directly produce
// for the same key, with no error and shared reported as false.
func TestDoReturnsCorrectResult(t *testing.T) {
	ResetCallCounts()

	var g Group

	v, err, shared := g.Do("k1", func() (int, error) { return Call("k1") })
	if err != nil {
		t.Fatalf(`Do("k1") returned error %v, want nil`, err)
	}

	if want := expectedResult("k1"); v != want {
		t.Errorf(`Do("k1") = %d, want %d`, v, want)
	}

	if shared {
		t.Errorf(`Do("k1") reported shared=true, want false (no other call was in flight)`)
	}
}

// TestDoDedupesConcurrentCallers calls Do for the SAME key from many
// goroutines at once and asserts that: they all observe the same
// result, Call ran exactly once, and exactly one caller - whichever
// actually ran fn - reports shared=false while every other caller
// reports shared=true. This guards against a "fixed" implementation
// that makes callers wait for each other but forgets to report
// sharing correctly, or that still lets more than one call through to
// Call. Run with `go test -race`.
func TestDoDedupesConcurrentCallers(t *testing.T) {
	ResetCallCounts()

	var g Group

	const key = "k2"
	const callers = 20

	results := make([]int, callers)
	errs := make([]error, callers)
	shareds := make([]bool, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()
			results[i], errs[i], shareds[i] = g.Do(key, func() (int, error) { return Call(key) })
		}()
	}
	wg.Wait()

	want := expectedResult(key)

	notShared := 0
	for i := 0; i < callers; i++ {
		if errs[i] != nil {
			t.Errorf("caller %d: Do returned error %v, want nil", i, errs[i])
		}

		if results[i] != want {
			t.Errorf("caller %d: Do = %d, want %d (all callers must observe the same result)", i, results[i], want)
		}

		if !shareds[i] {
			notShared++
		}
	}

	if notShared != 1 {
		t.Errorf("%d caller(s) reported shared=false, want exactly 1 (the single caller that actually ran fn - everyone else should have joined it)", notShared)
	}

	if cc := CallCount(key); cc != 1 {
		t.Errorf("Call ran %d time(s) across %d concurrent Do(%q) callers, want exactly 1", cc, callers, key)
	}
}

// TestDoPropagatesErrorToAllWaiters calls Do for a key whose backing
// call always fails, from many goroutines at once, and asserts that
// every caller - not just the one that actually ran fn - observes the
// SAME error, and that the backend still only ran once. A dedup
// implementation that only shares the success path (and lets every
// waiter re-run fn on error) would fail this test.
func TestDoPropagatesErrorToAllWaiters(t *testing.T) {
	ResetCallCounts()

	var g Group

	const key = "err-k3"
	const callers = 20

	errs := make([]error, callers)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()
			_, errs[i], _ = g.Do(key, func() (int, error) { return Call(key) })
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("caller %d: Do returned error %v, want %v", i, err, ErrUnavailable)
		}
	}

	if cc := CallCount(key); cc != 1 {
		t.Errorf("Call ran %d time(s) across %d concurrent Do(%q) callers, want exactly 1", cc, callers, key)
	}
}

// TestDoForgetsAfterCompletion calls Do for a key, waits for it to
// finish (Do is synchronous, so it already has by the time the call
// returns), then calls Do again for the SAME key and asserts the
// second call triggers a genuinely new call to fn - unlike exercise
// 17's Future, Group must NOT cache results forever. A second,
// sequential Do for the same key is a brand new call, not a cache
// hit, and must not be reported as shared.
func TestDoForgetsAfterCompletion(t *testing.T) {
	ResetCallCounts()

	var g Group

	const key = "k4"

	v1, err1, shared1 := g.Do(key, func() (int, error) { return Call(key) })
	if err1 != nil {
		t.Fatalf(`first Do(%q) returned error %v, want nil`, key, err1)
	}

	if shared1 {
		t.Errorf(`first Do(%q) reported shared=true, want false (nothing was in flight yet)`, key)
	}

	v2, err2, shared2 := g.Do(key, func() (int, error) { return Call(key) })
	if err2 != nil {
		t.Fatalf(`second Do(%q) returned error %v, want nil`, key, err2)
	}

	if shared2 {
		t.Errorf(`second, sequential Do(%q) reported shared=true, want false - the first call had already `+
			`completed and should have been forgotten, not cached`, key)
	}

	want := expectedResult(key)
	if v1 != want || v2 != want {
		t.Errorf(`Do(%q) calls returned %d and %d, want %d for both`, key, v1, v2, want)
	}

	if cc := CallCount(key); cc != 2 {
		t.Errorf("Call ran %d time(s) across two sequential Do(%q) calls, want exactly 2 - "+
			"Group must forget a key once its call completes, not cache the result forever", cc, key)
	}
}
