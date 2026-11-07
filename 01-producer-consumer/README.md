# Producer-Consumer Scenario

A producer reads tweets from a mock stream. A consumer checks each
tweet for Go content. Right now the producer finishes first. Only then
does the consumer start. The two parts do not overlap.

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

Change `main.go` so the producer and consumer run together. The
producer should pass each tweet to the consumer as soon as it is
ready.

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

## Test your solution

```
go test
go test -race
```
