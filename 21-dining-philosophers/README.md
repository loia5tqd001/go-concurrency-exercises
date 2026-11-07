# Dining Philosophers: Deadlock Avoidance

Five philosophers sit around a round table. Each adjacent pair shares
one fork. There are as many forks as philosophers.

A philosopher needs BOTH forks to eat. They need the fork on their left
and the fork on their right. They put both forks down after eating.

Today, every philosopher takes the left fork first. Everyone can then
hold one fork and wait for the right fork. That fork belongs to a
neighbor who is also waiting. This can close a cycle around the table.

```
P0 holds F0, wants F1 ──▶ held by P1
P1 holds F1, wants F2 ──▶ held by P2
P2 holds F2, wants F3 ──▶ held by P3
P3 holds F3, wants F4 ──▶ held by P4
P4 holds F4, wants F0 ──▶ held by P0   ◀── closes the ring back to P0
```

If everyone takes the left fork at about the same time, no one can eat.
Each philosopher holds one fork and waits for a neighbor's fork. Every
fork in the ring is already held by someone else. No one can move, and
`Dine` never returns.

Fix `Dine`. Every philosopher must finish all `mealsToEat` meals. This
must work for any number of philosophers and any goroutine schedule. Use
a standard deadlock-avoidance strategy. The ring must never close.

The function signature must stay the same:

```go
func Dine(numPhilosophers, mealsToEat int) (totalMealsEaten int32)
```

`numPhilosophers` is at least 2. With one philosopher, there are no two
adjacent forks.

Today, `go run .` will usually hang forever because of the fork-order
bug. That is the bug in this exercise. The tests guard the run with a
timeout, so they still finish.

## Test your solution

The tests must pass:

```
go test
go test --race
```
