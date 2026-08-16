# Or-Done Channel

`StartMetricStream` (`mockmonitor.go`) simulates a long-lived feed - a
metrics websocket, a tailed log - that emits one value every 20ms
forever. It never closes its channel, because it has no way to know
the consumer stopped listening.

`orDone(done, c)` should wrap `c` so a consumer can stop early by
closing `done`, without leaking the forwarding goroutine or forcing
every read site to write its own done-aware `select`.

Currently `orDone` just does `return c` - a no-op:

```
Today:   c ──────────────────────────▶ out        (out IS c, literally)

         close(done)  ✗ never observed anywhere - orDone doesn't even
                         have a goroutine that could react to it

Goal:    c ──▶ [forwarder goroutine] ──▶ out
                 │                 │
                 selects on        selects on
                 <-c  or  <-done   out<-v  or  <-done

         close(done) ──▶ unblocks whichever select is currently
                          parked (waiting on c, or waiting to send)
                          ──▶ forwarder returns ──▶ close(out)
```

## See the bug by running it

`main.go` reads 5 values, closes `done`, then does one more read on
`out` with a 200ms timeout to check whether `orDone` actually
stopped:

```
go run .
metric: 1
metric: 2
metric: 3
metric: 4
metric: 5
done reading, done closed - checking whether orDone actually stopped...
unexpected: got a value after done closed: 6
```

`StartMetricStream`'s goroutine is still ticking every 20ms regardless
of `done`, so the next value (6) shows up right on schedule instead of
`out` closing. Once you implement `orDone` for real, that last read
should instead see `out` closed (`ok == false`).

## Your task

Make `orDone` spawn a goroutine that ranges over `c` and forwards each
value onto a new output channel. Two operations in that goroutine can
block forever once the other side has walked away - receiving from
`c`, and sending on the output channel - so both need a `select` that
also watches `done`. When `done` closes, return promptly and close the
output channel. Keep the signature:

```go
func orDone(done <-chan struct{}, c <-chan int) <-chan int
```

## Test your solution

```
go test
go test --race
```
