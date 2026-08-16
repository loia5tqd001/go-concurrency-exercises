# Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One

This exercise picks up right where [14](../14-tee-channel) left off. `StartSensor` (see `mocksensor.go`) emits `count` incrementing integer readings, one every 5ms, then closes its channel. `Tee` duplicates every value it reads from `in` onto two independent output channels, so two consumers - say a live display and a logger - can each observe the full, identical sequence in order, even if one reads much slower than the other.

Given is a complete, correct answer to exercise 14 itself: for each value, an inner `select` with a nilled-out-on-send local channel per output sends it to whichever of `out1`/`out2` hasn't received it yet, so writing to one output never has to happen strictly before the other. `done` is respected throughout - if it fires, both outputs are abandoned and closed right away. None of that needs fixing.

What's missing is a stricter requirement on **closing**. Right now, closing is gated on the slowest consumer - a single goroutine holds value N until *both* outputs have received it before it even looks at value N+1, and only closes both channels together, once, after every value has gone to both:

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

So if one consumer has already received everything the sensor will ever produce, but the other hasn't read a single value yet, the fast consumer's channel still won't close.

Your task is to make each output close **on its own**, the moment every value has actually reached it, independent of the other output:

- If `done` fires, keep abandoning everything and closing both outputs right away, regardless of how much of `in` has been delivered - this part is already correct.
- Otherwise, once `in` is exhausted, `out1` must close as soon as it - specifically - has received every value, without waiting for `out2` to catch up, and vice versa. A fast consumer that has already received every value must see its channel close immediately, even if the other consumer hasn't read anything and is sitting on a full backlog. Gating both outputs' close on whichever consumer is slowest is not good enough.

This needs more than a tweak to the closing code: holding each value until both outputs receive it, one value at a time, in a single goroutine, structurally cannot let one output run arbitrarily far ahead of a completely unread other. Making closing independent means letting delivery to each output progress independently too.

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
