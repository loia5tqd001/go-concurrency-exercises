# Producer-Consumer — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `01-producer-consumer/`. Try solving it yourself first. Come back if you are stuck or want to compare approaches.

## The problem

A producer reads tweets from a mock stream. Each read takes about 320ms.
A consumer checks each tweet for Go content. Each check takes about
330ms. The starting code runs each stage in full before the next starts:

```go
func producer(stream Stream) (tweets []*Tweet) {
	for {
		tweet, err := stream.Next()
		if err == ErrEOF {
			return tweets
		}
		tweets = append(tweets, tweet)
	}
}

func consumer(tweets []*Tweet) {
	for _, t := range tweets {
		if t.IsTalkingAboutGo() {
			fmt.Println(t.Username, "\ttweets about golang")
		} else {
			fmt.Println(t.Username, "\tdoes not tweet about golang")
		}
	}
}

func main() {
	stream := GetMockStream()
	tweets := producer(stream)
	consumer(tweets)
}
```

Your task is to overlap the producer and consumer. The total time should
approach the slower stage. It should not equal the sum of both stages.

## Why the naive version is wrong

The code is correct. It produces the right output. But it runs the stages
one at a time. `producer` reads all 5 tweets and checks for `ErrEOF`
before `consumer` starts. The costs add up:

- Producer: 6 calls to `stream.Next()` (5 tweets + 1 EOF) × 320ms ≈ 1.92s
- Consumer: 5 calls to `IsTalkingAboutGo()` × 330ms ≈ 1.65s
- Total: ≈ 3.57s

Measured in a scratch build: **3.582s**. This matches the README's
"Before" figure of 3.58s.

Now run both stages at the same time. Pass tweets one at a time. The total
time is about `(one stream read) + (5 × max(read, process))`. It depends
on the slower cost per item, not their sum:

- 1st tweet ready at 320ms, consumer finishes it at 650ms
- 2nd tweet ready at 640ms (queued), consumer finishes at 980ms
- ... and so on, landing the last item at ≈ 1.97s

Measured for the overlapping version below: **1.976s**. This almost
matches the README's "After" figure of 1.977756255s.

The `Stream` has a strict rule. `mockstream.go` says it is "not
threadsafe," and `Next()` changes `s.pos` through a pointer receiver.
Only one goroutine may call `stream.Next()`. Keep the producer side
single-threaded. This keeps both designs race-free without a mutex.

## Approach 1: producer returns a channel, consumer ranges over it

This is the common Go fix. Make the producer stream results. Do not wait
for a full slice.

```go {1,2,3,4,10,17}
func producer(stream Stream) <-chan *Tweet {
	out := make(chan *Tweet)
	go func() {
		defer close(out)
		for {
			tweet, err := stream.Next()
			if err == ErrEOF {
				return
			}
			out <- tweet
		}
	}()
	return out
}

func consumer(tweets <-chan *Tweet) {
	for t := range tweets {
		if t.IsTalkingAboutGo() {
			fmt.Println(t.Username, "\ttweets about golang")
		} else {
			fmt.Println(t.Username, "\tdoes not tweet about golang")
		}
	}
}

func main() {
	start := time.Now()
	stream := GetMockStream()

	tweets := producer(stream)
	consumer(tweets)

	fmt.Printf("Process took %s\n", time.Since(start))
}
```

Why this works:

- `producer` starts one goroutine. That goroutine owns the `Stream`
  value. It sends each tweet on an unbuffered channel as soon as it reads
  it. It calls `close` on the channel when the stream ends. The return
  type is `<-chan *Tweet`, so callers can only receive.
- `consumer` uses `for t := range tweets`. It waits for a value and stops
  when the channel closes. It needs no separate done signal.
- The unbuffered channel keeps both stages in step. The producer waits on
  `out <- tweet` until the consumer is ready. The consumer waits for the
  next item. They run at the same time, but the slower stage controls
  throughput.

**Verified** in a scratch copy, not the live `01-producer-consumer/`
directory:

- `go run .` prints all 5 lines in order. It reports
  `Process took 1.976337959s`. The starting version reports
  `Process took 3.582158667s`.
- `go run -race .` reports no data race.
- A temporary test showed the first tweet after about 320ms. This is one
  stream read, not all five.

A buffered channel does not help here. The consumer is slower, at 330ms
against 320ms. A buffer can let the producer submit a little sooner. The
last tweet still finishes at about 1.97s. Buffering helps when the
producer is faster than a bursty consumer.

## Approach 2: fan-out to multiple consumer workers (alternative)

This design keeps the single producer, since `Stream` is not thread-safe.
It starts several consumer goroutines. They all read from the same
channel. A `sync.WaitGroup` waits for them all.

```go {17,35,37,39}
func producer(stream Stream) <-chan *Tweet {
	out := make(chan *Tweet)
	go func() {
		defer close(out)
		for {
			tweet, err := stream.Next()
			if err == ErrEOF {
				return
			}
			out <- tweet
		}
	}()
	return out
}

func consumer(tweets <-chan *Tweet, wg *sync.WaitGroup) {
	defer wg.Done()
	for t := range tweets {
		if t.IsTalkingAboutGo() {
			fmt.Println(t.Username, "\ttweets about golang")
		} else {
			fmt.Println(t.Username, "\tdoes not tweet about golang")
		}
	}
}

func main() {
	start := time.Now()
	stream := GetMockStream()

	tweets := producer(stream)

	const numWorkers = 3
	var wg sync.WaitGroup
	wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go consumer(tweets, &wg)
	}
	wg.Wait()

	fmt.Printf("Process took %s\n", time.Since(start))
}
```

Many goroutines can range over one channel. Each value goes to only one
goroutine. No two workers process the same tweet. `wg.Wait()` in `main`
waits until all workers finish.

**Verified** in the same scratch copy. It builds, `go vet` is clean, and
`go run -race .` reports no race. The output is correct. It reports
`Process took ~1.935s`. Three runs gave 1.9348s, 1.9346s, and 1.9354s.

Two caveats:

- **It barely helps here.** The time is about 1.935s, against 1.976s for
  one consumer. The producer is the bottleneck at 320ms per item. More
  consumers cannot make it read faster. Use this pattern when the
  consumer is slower.
- **It does not keep output order.** Several readers can return values in
  any order. The sample run kept order by chance. A different run may
  print in another order. That is not a bug.

## Key takeaways

- The starting version is correct but slow. Its total time is the sum of
  both stages. Overlap brings 3.58s down to about 1.98s.
- The common pattern returns a `<-chan T` from the producer. Close it in
  the goroutine that sends. The consumer uses `for range`. One consumer
  needs no done flag, mutex, or extra coordination.
- `Stream` is not thread-safe. Only one goroutine may call `stream.Next()`.
  You can add consumers, but not producers.
- Approach 2 is a worker pool with `sync.WaitGroup`. It helps only when
  the consumer is the bottleneck. Here it saves little and loses order.
