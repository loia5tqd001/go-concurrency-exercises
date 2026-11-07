# Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One

This exercise follows [14](../14-tee-channel). `StartSensor` (see
`mocksensor.go`) sends `count` readings, one every 5ms. Then it closes
its channel. `Tee` copies every input value to two output channels.
Two consumers can then receive the full sequence in order. One may
read much more slowly.

Exercise 14 already has a correct `Tee`. For each value, it uses one
inner `select` with one local channel per output. It sets a local
channel to nil after that output gets the value. The outputs can
receive each value independently. If `done` closes, both outputs stop
and close. You do not need to fix that part.

The new requirement is closing. Today, one goroutine waits for both
outputs to get a value before it reads the next value. If `out2` is
never read, the goroutine waits forever. `out1` then blocks and
cannot close.

```
today:  in ──▶ [one goroutine: holds v until BOTH out1 AND out2 took it] ──┬──▶ out1
                                                                           └──▶ out2
        out2 left unread ⇒ goroutine parked forever on out2's send
                         ⇒ out1 starves too, and close(out1) waits on out2 catching up

goal:   in ──┬──▶ [out1's own delivery, own completion-tracking] ──▶ out1 closes the
             │                                                       instant OUT1 has it all
             └──▶ [out2's own delivery, own completion-tracking] ──▶ out2 closes the
                                                                     instant OUT2 has it all
```

So one consumer may receive every value. The other may read none. The
fast consumer's channel still will not close.

Your task is to make each output close on its own. Each channel must
close as soon as it receives every value. It must not wait for the
other output.

- If `done` closes, stop everything and close both outputs at once.
  This part already works.
- Otherwise, after `in` ends, close `out1` as soon as `out1` receives
  every value. Do not wait for `out2`. Do the same for `out2` if it
  finishes first. A fast consumer must get its close even if the other
  consumer has read nothing and has a full backlog.

This needs more than a small change to the close code. One goroutine
cannot hold each value until both outputs receive it. That design
cannot let one output move far ahead of an unread output. Each output
must make delivery progress on its own.

The function signature must stay the same:

```go
func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int)
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
