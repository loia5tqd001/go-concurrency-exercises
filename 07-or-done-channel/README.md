# Or-Done Channel

`StartMetricStream` in `mockmonitor.go` sends one value every 20 ms. It
can run forever. It never closes its channel. It does not know when the
reader stops.

`orDone(done, c)` should wrap `c` in a new `out` channel. Do not use
`return c`. Closing `done` must stop the reader. The forwarding
goroutine must not leak.

Right now `orDone` uses `return c`. It does nothing:

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

`main.go` reads five values. It closes `done`. Then it waits 200 ms for
one more value:

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

The stream still runs. It sends value 6 even after `done` closes. When
`orDone` works, the last read should get `ok == false`.

## Your task

Make `orDone` start a goroutine. It should forward values from `c` to a
new channel. A receive from `c` can block. A send to the output can also
block. Both operations need a `select` that also watches `done`. When
`done` closes, return and close the output. Keep the signature:

```go
func orDone(done <-chan struct{}, c <-chan int) <-chan int
```

## Test your solution

```
go test
go test --race
```
