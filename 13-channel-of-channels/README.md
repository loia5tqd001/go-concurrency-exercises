# Channel of Channels (Bridge Pattern)

Given is a `LogHub` (see `mockloghub.go`) that simulates log-collecting
infrastructure where new "shard" sources connect over time. Instead of
handing you a single channel of log lines, `StartLogHub` returns a
channel of channels: every value it emits is itself a channel carrying
the log lines from one shard, which closes once that shard is done.
`StartLogHub` closes the outer channel once all of its shards have
been started - but by then, the shards themselves may still be
producing lines.

The naive `Bridge` function in `main.go` is supposed to flatten this
channel-of-channels into a single stream of log lines that `main` can
simply range over. It doesn't: it only ever looks at the very first
inner channel it receives, forwards its lines, and then stops -
silently dropping every log line produced by every other shard.

Your task is to fix `Bridge` so that it flattens **every** inner
channel it ever receives from `chanStream` into the single output
stream - a fan-in over a dynamically arriving, unbounded set of
channels. The output channel must close once `chanStream` itself has
been closed **and** every inner channel it ever produced has been
fully drained. `Bridge` must also stop promptly - closing its output
and abandoning any further reads - as soon as `done` is closed.

That fan-in must also be genuinely concurrent: a shard that stalls (or
never closes) must not delay lines from any other shard, whether
already open or still to arrive on `chanStream`. It's not enough to
drain each inner channel to completion before going back to
`chanStream` for the next one - that satisfies every requirement above
while still letting one stuck shard starve every shard behind it,
including ones `Bridge` hasn't even read off `chanStream` yet. The
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

This includes `TestBridgeDoesNotStarveOnSlowShard`, which opens a shard
that never sends and never closes alongside a shard with a line
already waiting, and expects that line promptly regardless - a
sequential "finish this shard, then read the next one off chanStream"
`Bridge` passes every other test here but times out on this one.
