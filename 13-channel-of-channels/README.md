# Channel of Channels (Bridge Pattern)

`LogHub` (see `mockloghub.go`) simulates a log system. New shard
sources connect over time. `StartLogHub` returns a channel of channels.
Each inner channel carries one shard's log lines. It closes when that
shard finishes. The outer channel closes after all shards start. The
shards may still send lines at that point.

`Bridge` should merge all log lines into one stream. The current
version in `main.go` reads only the first inner channel. `main` then
stops. Lines from other shards are dropped, and those hub goroutines
can block forever.

```
Today - naive Bridge: 1 goroutine, reads only shard-0

  chanStream ──▶ shard-0 ──▶ [Bridge] ──▶ out   (4 of 20 lines)
                 shard-1..4  ✗ never read, 16 lines dropped;
                             hub goroutines block forever

Goal - fan-in: shards arrive every 5 ms, a line every 10 ms

  chanStream ──┬─▶ shard-0 ──▶ fwd-0 ─┐
               ├─▶ shard-1 ──▶ fwd-1 ─┤   1 dispatcher +
               ├─▶ shard-2 ──▶ fwd-2 ─┼──▶ out ──▶ main (20 lines)
               ├─▶ shard-3 ──▶ fwd-3 ─┤   one goroutine
               └─▶ shard-4 ──▶ fwd-4 ─┘   per shard
                             out closes once chanStream is closed
                             AND all 5 forwarders finish, or on done
                             a stuck shard stalls only its own fwd
```

Your task is to fix `Bridge`. It must merge every inner channel from
`chanStream` into one output stream. Shards can arrive at any time.
The final number is not known in advance. Close the output after `chanStream`
closes and every inner channel is fully drained. If `done` closes,
stop sooner. Close the output and stop reading.

The merge must run at the same time. A stuck shard must not delay other
shards, whether they are open now or arrive later. Reading one shard
fully before the next is not enough. It can block every shard behind
the stuck one, including shards still waiting on `chanStream`. The
function signature must stay the same:

```go
func Bridge(chanStream <-chan (<-chan string), done <-chan struct{}) <-chan string
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```

`TestBridgeDoesNotStarveOnSlowShard` adds two shards. One never sends
or closes. The other already has a waiting line. The test expects
that line quickly. A `Bridge` that finishes one shard before reading
the next fails this test, even if it passes the others.
