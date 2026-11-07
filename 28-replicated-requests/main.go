//////////////////////////////////////////////////////////////////////
//
// FetchFastest sends one request to several replicas.
// It returns the first response.
// The current code leaves losing replicas running until they finish.
// It gives every replica a nil done channel.
//
// Your task is to cancel every losing replica.
// Cancel them after a winner or after the caller's done closes.
// Keep these signatures:
//
//   type Replica func(done <-chan struct{}) (string, error)
//   func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error)
//

package main

import (
	"errors"
	"fmt"
	"time"
)

// Replica handles one redundant request.
// It must return when done closes.
type Replica func(done <-chan struct{}) (string, error)

// replicaResult carries one replica's result.
type replicaResult struct {
	value string
	err   error
}

// FetchFastest calls every replica and returns the first result.
// A closed done returns an error with no winner.
func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {
	if len(replicas) == 0 {
		return "", errors.New("fetchfastest: no replicas provided")
	}

	results := make(chan replicaResult, len(replicas))

	for _, replica := range replicas {
		go func(r Replica) {
			// BUG: nil done means this replica cannot cancel.
			value, err := r(nil)
			results <- replicaResult{value: value, err: err}
		}(replica)
	}

	select {
	case res := <-results:
		return res.value, res.err
	case <-done:
		return "", errors.New("fetchfastest: cancelled before any replica responded")
	}
}

func main() {
	replicas := []Replica{
		NewMockReplica("replica-A", 150*time.Millisecond).Replica,
		NewMockReplica("replica-B", 10*time.Millisecond).Replica,
		NewMockReplica("replica-C", 300*time.Millisecond).Replica,
	}

	done := make(chan struct{})
	start := time.Now()

	value, err := FetchFastest(done, replicas...)

	fmt.Printf("winner after %s: value=%q err=%v\n", time.Since(start), value, err)
	fmt.Println("...but replica-A and replica-C are still out there, running to completion")
	fmt.Println("in the background, even though nobody is listening for their result anymore.")

	// Keep the demo alive while losing replicas keep running.
	time.Sleep(400 * time.Millisecond)
}
