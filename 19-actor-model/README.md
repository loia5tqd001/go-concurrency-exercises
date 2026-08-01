# Actor Model: A Bank Account With No Locks

Given is an `Account` that is supposed to be safe for concurrent
`Deposit`/`Withdraw`/`Balance` calls from many goroutines at once.
Right now it is not: `balance` is read and written directly, with no
synchronization of any kind, so concurrent calls race on it (lost
updates, torn reads) - and `Withdraw` doesn't even check for
sufficient funds before letting the balance go negative.

Your task is to reimplement `Account` the "share memory by
communicating" way, using the actor pattern instead of a mutex:
`NewAccount` should start a single long-lived goroutine that owns
`balance` and processes exactly one request at a time from an
unexported channel of request structs. `Deposit`, `Withdraw`, and
`Balance` become thin methods that build a request, send it on that
channel, and block on a reply channel for the result. Correctness
must come purely from serializing all access to `balance` through
that single actor goroutine - no `sync.Mutex` (or any other lock) may
be used anywhere.

`Withdraw` must return `ErrInsufficientFunds` - and leave `balance`
unchanged - if `amount` is greater than `balance` at the time the
actor goroutine processes the request. The function signatures must
stay the same:

```go
func NewAccount(initial int) *Account
func (a *Account) Deposit(amount int)
func (a *Account) Withdraw(amount int) error
func (a *Account) Balance() int
```

## Test your solution

To complete this exercise, you must pass the tests:

```
go test
go test --race
```
