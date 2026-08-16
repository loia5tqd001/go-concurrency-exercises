# Producer-Consumer Scenario

A producer reads tweets one at a time from a mockstream; a consumer checks each one for Go-related content. Right now `main.go` runs them back-to-back: the producer fills a whole slice before the consumer looks at a single tweet, so the total cost is additive, not overlapped.

```
today (serial):
  producer  [read][read][read][read][read]
  consumer                                 [check][check][check][check][check]
            └─────────── ~1.92s ──────────┴─────────── ~1.65s ───────────┘   ≈ 3.58s total

goal (pipelined):
  producer  [read][read][read][read][read]
  consumer         [check][check][check][check][check]
            └ 1 read ┴──── overlapped, paced by the slower stage ─────┘   ≈ 1.98s total
```

Your task: change `main.go` so producer and consumer run concurrently and hand off tweets as they're ready, instead of the producer finishing entirely first.

## Expected results:
Before: 
```
davecheney      tweets about golang
beertocode      does not tweet about golang
ironzeb         tweets about golang
beertocode      tweets about golang
vampirewalk666  tweets about golang
Process took 3.580866005s
```

After:
```
davecheney      tweets about golang
beertocode      does not tweet about golang
ironzeb         tweets about golang
beertocode      tweets about golang
vampirewalk666  tweets about golang
Process took 1.977756255s
```
