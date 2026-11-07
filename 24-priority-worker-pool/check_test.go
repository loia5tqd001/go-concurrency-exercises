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

// jobLatency matches the worker's simulated work time.
const jobLatency = 20 * time.Millisecond

// readCompletions reads n job IDs in arrival order.
// A timeout stops a broken scheduler from hanging the test.
func readCompletions(t *testing.T, sched *Scheduler, n int) []int {
	t.Helper()

	got := make([]int, 0, n)
	for i := 0; i < n; i++ {
		select {
		case id := <-sched.Completed():
			got = append(got, id)
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for completion %d/%d", i+1, n)
		}
	}

	return got
}

func indexOf(ids []int, id int) int {
	for i, v := range ids {
		if v == id {
			return i
		}
	}
	return -1
}

// TestSchedulerCompletesAllJobs checks that every job finishes once.
// It does not check order.
func TestSchedulerCompletesAllJobs(t *testing.T) {
	sched := NewScheduler()

	const n = 10
	priorities := []int{5, 1, 3, 9, 1, 7, 2, 2, 8, 4}
	for i := 0; i < n; i++ {
		sched.Submit(Job{ID: i + 1, Priority: priorities[i]})
	}

	got := readCompletions(t, sched, n)

	seen := make(map[int]bool, n)
	for _, id := range got {
		if seen[id] {
			t.Errorf("job %d completed more than once", id)
		}
		seen[id] = true
	}

	for i := 0; i < n; i++ {
		id := i + 1
		if !seen[id] {
			t.Errorf("job %d never completed", id)
		}
	}
}

// TestSchedulerPrioritizesUrgentJobs checks an urgent job.
// The worker starts job 1 first.
// Jobs 2 through 6 are low priority.
// Job 7 is urgent.
// Job 7 must finish first or second, not behind the backlog.
func TestSchedulerPrioritizesUrgentJobs(t *testing.T) {
	sched := NewScheduler()

	sched.Submit(Job{ID: 1, Priority: 1})
	time.Sleep(5 * time.Millisecond) // let the worker pick job 1 up

	for id := 2; id <= 6; id++ {
		sched.Submit(Job{ID: id, Priority: 1})
	}
	sched.Submit(Job{ID: 7, Priority: 10})

	got := readCompletions(t, sched, 7)

	idx := indexOf(got, 7)
	if idx < 0 {
		t.Fatalf("job 7 never completed; order was %v", got)
	}
	if idx > 1 {
		t.Errorf("job 7 (priority 10) completed at position %d in %v; "+
			"want it within the first two completions, i.e. right after whatever "+
			"was already running - not stuck behind the low-priority backlog (jobs 2-6)",
			idx, got)
	}
}

// TestSchedulerTiesBrokenByArrivalOrder checks equal-priority jobs.
// They must finish in submission order.
func TestSchedulerTiesBrokenByArrivalOrder(t *testing.T) {
	sched := NewScheduler()

	sched.Submit(Job{ID: 1, Priority: 5})
	time.Sleep(5 * time.Millisecond) // let the worker pick job 1 up

	for id := 2; id <= 6; id++ {
		sched.Submit(Job{ID: id, Priority: 5})
	}

	got := readCompletions(t, sched, 6)

	want := []int{1, 2, 3, 4, 5, 6}
	for i, id := range want {
		if got[i] != id {
			t.Fatalf("completion order = %v, want %v (same-priority jobs must finish "+
				"in submission order)", got, want)
		}
	}
}

// TestSchedulerRace submits jobs from many goroutines.
// Run it with `go test -race`.
func TestSchedulerRace(t *testing.T) {
	sched := NewScheduler()

	const n = 50
	done := make(chan struct{})
	for i := 0; i < n; i++ {
		go func(id int) {
			sched.Submit(Job{ID: id, Priority: id % 5})
			done <- struct{}{}
		}(i)
	}
	// A broken Submit can deadlock.
	// Stop the test instead of waiting for the Go timeout.
	for i := 0; i < n; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for Submit %d/%d to return", i+1, n)
		}
	}

	seen := make(map[int]bool, n)
	for i := 0; i < n; i++ {
		select {
		case id := <-sched.Completed():
			seen[id] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for completion %d/%d", i+1, n)
		}
	}

	if len(seen) != n {
		t.Errorf("expected %d distinct completed jobs, got %d", n, len(seen))
	}
}
