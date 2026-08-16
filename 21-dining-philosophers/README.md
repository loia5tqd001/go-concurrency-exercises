# Dining Philosophers: Deadlock Avoidance

Five philosophers sit around a round table. Between each adjacent pair
of philosophers sits exactly one fork, so there are as many forks as
philosophers. To eat, a philosopher needs to pick up BOTH the fork to
their left and the fork to their right - only then can they eat, after
which they put both forks back down so their neighbors can use them.

Right now every philosopher reaches for forks in the same order -
left, then right - which lets a circular wait close around the whole
table:

```
P0 holds F0, wants F1 ──▶ held by P1
P1 holds F1, wants F2 ──▶ held by P2
P2 holds F2, wants F3 ──▶ held by P3
P3 holds F3, wants F4 ──▶ held by P4
P4 holds F4, wants F0 ──▶ held by P0   ◀── closes the ring back to P0
```

If every philosopher succeeds in grabbing their left fork at roughly
the same time, each is left holding one fork while waiting forever for
their right fork - held by a neighbor who is, in turn, stuck waiting on
THEM. Every wanted fork in the ring is already held by someone else
also waiting, so nobody ever eats again and `Dine` never returns.

Your task is to fix `Dine` so every philosopher finishes all
`mealsToEat` meals, no matter how many philosophers sit down or how
their goroutines happen to get scheduled - using a standard,
well-known deadlock-avoidance strategy. Whatever mechanism you pick,
the ring above must never be able to close completely.

The function signature must stay the same:

```go
func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)
```

Note: because of the fork-ordering bug, running `go run .` directly
will, in practice, hang forever essentially every time. That's the bug
this exercise is about - the graded artifact is the test suite, which
guards the run with a timeout instead of waiting on it forever.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
