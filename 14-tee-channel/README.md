# Tee Channel: Duplicating a Sensor Stream to Two Consumers

`StartSensor` (see `mocksensor.go`) simulates a sensor. It sends
`count` readings, one every 5ms. The readings increase by one. Then
the channel closes. Two consumers need the full stream. One might be
a live display and the other a logger. One may read more slowly.

`Tee` should copy every value from `in` to two independent consumers.
Today, it returns the same input channel twice. Both outputs are the
same channel. Each value goes to only one racing reader. The other
reader loses that value.

```
TODAY - both outputs are the same channel; Tee starts no goroutine

  StartSensor(10) --5ms--> in == same channel ==+--> out1: reader 1 races
                                                +--> out2: reader 2 races
  each value reaches ONE racing reader only; neither is guaranteed all 10

GOAL - one tee goroutine reads in and sends each value to BOTH outputs

  StartSensor(10) --5ms--> in --> tee goroutine --+--> out1 --> reader 1: 0..9
                                                  +--> out2 --> reader 2: 0..9
  each value is held for BOTH outputs; a slow reader still gets all 10
  done closed --> both outputs close at once
```

Your task is to implement `Tee`. Send every input value to both
outputs. Each output must receive the same values in the same order.
For each value, track which outputs have it. Use one inner `select`
with a case for each output. This lets the outputs receive the value
independently. Send it to each output until both have it. Respect
`done` and stop if it closes. Close both outputs when `in` ends or
`done` closes.

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
