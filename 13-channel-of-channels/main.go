//////////////////////////////////////////////////////////////////////
//
// Bridge combines a changing set of inner channels into one output.
// The naive version reads only the first inner channel.
// Read new shards while older shards are still being drained.
// Close output only after the outer and every inner channel close.
// Stop promptly and close output when done closes.
//
//     func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string
//

package main

import "fmt"

// Bridge flattens every inner channel into one output.
// The naive version drops every shard after the first.
func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string {
	valStream := make(chan string)

	go func() {
		defer close(valStream)

		stream, ok := <-chanStream
		if !ok {
			return
		}

		for {
			select {
			case <-done:
				return
			case v, ok := <-stream:
				if !ok {
					return
				}
				select {
				case valStream <- v:
				case <-done:
					return
				}
			}
		}
	}()

	return valStream
}

func main() {
	done := make(chan struct{})
	// This normal run leaves done open.

	shardStream := StartLogHub(5, 4)
	logs := Bridge(shardStream, done)

	count := 0
	for line := range logs {
		fmt.Println(line)
		count++
	}

	fmt.Println("Total log lines:", count)
}
