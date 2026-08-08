# Tee Channel: Duplicating a Sensor Stream to Two Consumers

Given is a function `StartSensor` (see `mocksensor.go`) that simulates a
hardware sensor: it emits `count` incrementing integer readings, one
every 5ms, then closes its channel. Two independent consumers need to
see the full stream - say, a live display and a logger - and one of
them might read slower than the other.

`Tee` is supposed to duplicate every value read from `in` so that TWO
independent consumers can each see the full sequence, even if one
consumer reads slower than the other. The current implementation does
nothing of the sort - it just returns the same input channel twice,
which means the two "outputs" are actually the SAME channel: whichever
consumer happens to read a given value first gets it, and the other
consumer never sees that value at all. Values get split between the
two consumers instead of duplicated to both.

Your task is to implement `Tee` properly: every value received from
`in` must be sent to BOTH output channels, so each output ends up with
the full, identical sequence of values `in` produced, in order. For
each value, hold onto it and, using an inner select per output channel
(so writing to one output doesn't have to happen strictly before the
other, and a slow reader on one output doesn't stall forever if `done`
fires), send it to whichever output(s) haven't received it yet, until
both have. Respect `done` throughout, abandoning early if it closes.

Closing the outputs has two parts:

- If `done` fires, abandon everything and close both outputs right
  away, regardless of how much of `in` has been delivered.
- Otherwise, once `in` is exhausted, each output must close **on its
  own**, the moment every value has actually reached it - independent
  of the other output. A fast consumer that has already received every
  value must see its channel close immediately, even if the other
  consumer hasn't read a single value yet and is sitting on a full
  backlog. Gating both outputs' close on whichever consumer is
  slowest (e.g. one shared "wait for everything, then close both"
  step) is not good enough.

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
