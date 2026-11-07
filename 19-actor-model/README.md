# Actor Model: A Bank Account With No Locks

`Account` should handle `Deposit`, `Withdraw`, and `Balance` calls from
many goroutines safely.

Today, `balance` is read and written directly without protection.
`Withdraw` also does not check funds. The balance can go below zero.

```
today:  goroutine A ─┐
        goroutine B ─┼─▶ read-modify-write a.balance directly ─▶ races
        goroutine C ─┘

goal:   goroutine A ─┐        request           actor goroutine
        goroutine B ─┼─▶ {op, amount, reply} ─▶ owns balance, one
        goroutine C ─┘                         │ request at a time
                     ◀───────────── reply ─────┘
```

Reimplement `Account` with the actor pattern instead of a mutex.
`NewAccount` starts one long-lived goroutine. That goroutine owns
`balance` and handles one request at a time. It reads requests from an
unexported channel of request structs.

`Deposit`, `Withdraw`, and `Balance` each send one request. They wait
for the actor's reply before they return. `Deposit` ignores the reply
value, but it must still receive it. All access to `balance` must go
through the actor. Do not use `sync.Mutex` or any other lock.

If `amount` is greater than `balance`, `Withdraw` returns
`ErrInsufficientFunds`. It must leave `balance` unchanged. The actor
checks this when it handles the request. The function signatures must
stay the same:

```go
func NewAccount(initial int) *Account
func (a *Account) Deposit(amount int)
func (a *Account) Withdraw(amount int) error
func (a *Account) Balance() int
```

The actor goroutine runs until it is told to stop. `Account` therefore
needs a `Close` method:

```go
func (a *Account) Close()
```

`Close` must stop the actor goroutine. The goroutine must exit shortly
after `Close`. The tests do not call `Deposit`, `Withdraw`, or
`Balance` after `Close`. Their behavior after close is up to you.

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
