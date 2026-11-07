# Actor model: a bank account without locks

> **Spoiler warning.** This file has full solutions for `19-actor-model/`. Try the exercise first. Come back if you get stuck.

## The problem

`Account` must be safe when many goroutines call `Deposit`, `Withdraw`, and `Balance`. The task asks for the "share memory by communicating" style.

`NewAccount` starts one long-lived goroutine. That goroutine owns `balance` and handles one request at a time from an unexported channel.

`Deposit`, `Withdraw`, and `Balance` send a request and wait for a reply. They stay thin.

The README forbids `sync.Mutex` and every other lock. This exercise is about message passing. It is not just about making `Account` safe by any means.

`Withdraw` must return `ErrInsufficientFunds` when `amount` is larger than `balance`. The balance must not change.

The funds check and debit must act as one atomic step under concurrent withdrawals.

`TestAccountWithdrawRejectsInsufficientFunds` starts 5 withdrawals of 30 against a balance of 100. No more than 3 may succeed. The final balance must be exact and not negative.

## Why the naive version is wrong

```go
func (a *Account) Deposit(amount int) {
	a.balance = a.balance + amount
}

func (a *Account) Withdraw(amount int) error {
	a.balance = a.balance - amount
	return nil
}
```

The code reads and writes `balance` with no synchronization. `Withdraw` also checks no funds. I ran `go test -race ./...` against this version. It fails in several ways:

```
--- FAIL: TestAccountBasicOperations (0.00s)
    check_test.go:130: Withdraw(1000) from balance 120 = <nil>, want ErrInsufficientFunds
    check_test.go:133: balance after rejected withdraw = -880, want unchanged 120
--- FAIL: TestAccountConcurrentSafety (0.00s)
    check_test.go:182: final balance = 10836, want 11000 (exactly initial + 1000 concurrent deposits of 1)
    testing.go:1617: race detected during execution of test
WARNING: DATA RACE
Read at 0x00c000010358 by goroutine 17:
  (*Account).Deposit()  main.go:67
Previous write at 0x00c000010358 by goroutine 16:
  (*Account).Deposit()  main.go:67
--- FAIL: TestAccountWithdrawRejectsInsufficientFunds (0.00s)
    check_test.go:231: final balance went negative: -50
--- FAIL: TestNewAccountStartsActorGoroutineAndCloseStopsIt (0.00s)
    check_test.go:358: goroutine count was 2 before NewAccount and 2 right after (want it to increase)
```

`Withdraw(1000)` from a balance of 120 succeeds and leaves -880. The funds check is missing.

Concurrent deposits lose updates. The final balance is 10836 instead of 11000. The test starts with 10000 and runs 1000 concurrent `+1` deposits.

The race detector reports the unprotected `balance` access. Concurrent withdrawals also reach -50. Nothing keeps the check and debit together.

`NewAccount` starts no goroutine. There is no actor to handle requests one at a time.

## Approach 1: actor goroutine (message-passing, no locks)

One goroutine, `run`, owns `balance` as a local variable. No other goroutine touches it. `run` reads requests from an unbuffered channel and handles them one at a time. There is no shared access and no race, so no lock is needed.

```go {42,50,77}
package main

import (
	"errors"
	"fmt"
	"sync"
)

const (
	opDeposit = iota
	opWithdraw
	opBalance
)

// request is sent to the actor goroutine to ask it to perform one
// operation on the account and reply with the result.
type request struct {
	kind   int
	amount int
	reply  chan response
}

// response carries the result of a request back to the caller.
type response struct {
	balance int
	err     error
}

// Account is safe for concurrent Deposit/Withdraw/Balance calls from
// many goroutines at once: a single actor goroutine owns balance and
// processes exactly one request at a time from requests, so there is
// never more than one goroutine touching balance - no mutex needed.
type Account struct {
	requests chan request
}

func NewAccount(initial int) *Account {
	a := &Account{
		requests: make(chan request),
	}

	go a.run(initial)

	return a
}

// run is the actor loop: it owns balance exclusively and serializes
// every operation on it by processing requests one at a time.
func (a *Account) run(balance int) {
	for req := range a.requests {
		switch req.kind {
		case opDeposit:
			balance += req.amount
			req.reply <- response{balance: balance}
		case opWithdraw:
			if req.amount > balance {
				req.reply <- response{balance: balance, err: ErrInsufficientFunds}
				continue
			}
			balance -= req.amount
			req.reply <- response{balance: balance}
		case opBalance:
			req.reply <- response{balance: balance}
		}
	}
}

// Close terminates the actor goroutine by closing requests, which ends
// run's range loop.
func (a *Account) Close() {
	close(a.requests)
}

func (a *Account) Deposit(amount int) {
	reply := make(chan response)
	a.requests <- request{kind: opDeposit, amount: amount, reply: reply}
	<-reply
}

// Withdraw fails with ErrInsufficientFunds rather than letting
// balance go negative.
func (a *Account) Withdraw(amount int) error {
	reply := make(chan response)
	a.requests <- request{kind: opWithdraw, amount: amount, reply: reply}
	resp := <-reply
	return resp.err
}

func (a *Account) Balance() int {
	reply := make(chan response)
	a.requests <- request{kind: opBalance, reply: reply}
	resp := <-reply
	return resp.balance
}

var ErrInsufficientFunds = errors.New("insufficient funds")

func main() {
	account := NewAccount(1000)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account.Deposit(1)
		}()
	}
	wg.Wait()

	fmt.Printf("final balance after 100 concurrent deposits of 1: %d (want 1100)\n", account.Balance())

	if err := account.Withdraw(2000); err != nil {
		fmt.Printf("withdraw correctly rejected: %v\n", err)
	} else {
		fmt.Printf("withdraw of 2000 from a smaller balance was allowed - balance is now %d\n", account.Balance())
	}
}
```

`go test -race -count=20 ./...` passes all 20 runs. The balances are exact, and there are no races.

This includes the insufficient-funds test. No more than `initial/amount` withdrawals succeed, and the balance never goes negative.

Both `Close` tests also pass. The actor goroutine starts in `NewAccount` and stops after `Close`.

Two details are easy to get wrong:

- `check_test.go` requires the `Withdraw` check and debit to act as one step. They sit in the same `case opWithdraw:` inside one goroutine. No other request can run between them.
- `Deposit` waits on `<-reply` and discards the value. That wait is required.
- `req.reply <- response{...}` is a send on an unbuffered channel. If `Deposit` does not receive, `run` blocks while replying.
- The whole account then stops. I removed `<-reply` and ran `TestAccountBasicOperations`.
- It reported `Balance() did not return within 2s - a wedged actor goroutine blocks every future call too` after about two seconds.
- The timeout guard turns a long hang into a short, clear failure.

## Approach 1b: actor goroutine with typed messages instead of a tagged struct

This uses the same idea as Approach 1. One actor goroutine owns `balance`, and no locks are used.

The message shape changes. Each operation gets its own type, not one `request` with a `kind` field. The actor switches on the dynamic message type, not an `int`.

```go {12,42}
package main

import (
	"errors"
	"fmt"
	"sync"
)

// Command is any of DepositCommand, WithdrawCommand, or
// GetBalanceCommand - the actor type-switches on it instead of
// branching on a tag field.
type Command any

type DepositCommand struct {
	amount int
}

type WithdrawCommand struct {
	amount  int
	replyCh chan error
}

type GetBalanceCommand struct {
	replyCh chan int
}

type Account struct {
	cmdCh chan Command
}

func NewAccount(initial int) *Account {
	a := &Account{cmdCh: make(chan Command)}
	go a.loop(initial)
	return a
}

// loop is the actor: balance lives only as its local variable, so no
// other goroutine can ever reach it - ownership is structural, not a
// matter of every method remembering to go through a lock.
func (a *Account) loop(balance int) {
	for cmd := range a.cmdCh {
		switch c := cmd.(type) {
		case DepositCommand:
			balance += c.amount

		case WithdrawCommand:
			newBalance := balance - c.amount
			if newBalance < 0 {
				c.replyCh <- ErrInsufficientFunds
			} else {
				balance = newBalance
			}
			close(c.replyCh)

		case GetBalanceCommand:
			c.replyCh <- balance
			close(c.replyCh)
		}
	}
}

func (a *Account) Deposit(amount int) {
	a.cmdCh <- DepositCommand{amount}
}

func (a *Account) Withdraw(amount int) error {
	replyCh := make(chan error)
	a.cmdCh <- WithdrawCommand{amount, replyCh}
	return <-replyCh
}

func (a *Account) Balance() int {
	replyCh := make(chan int)
	a.cmdCh <- GetBalanceCommand{replyCh}
	return <-replyCh
}

func (a *Account) Close() {
	close(a.cmdCh)
}

var ErrInsufficientFunds = errors.New("insufficient funds")

func main() {
	account := NewAccount(1000)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account.Deposit(1)
		}()
	}
	wg.Wait()

	fmt.Printf("final balance after 100 concurrent deposits of 1: %d (want 1100)\n", account.Balance())

	if err := account.Withdraw(2000); err != nil {
		fmt.Printf("withdraw correctly rejected: %v\n", err)
	} else {
		fmt.Printf("withdraw of 2000 from a smaller balance was allowed - balance is now %d\n", account.Balance())
	}
}
```

`go test -race -count=20 ./...` passes all 20 runs. This includes both `Close` tests.

Compared with Approach 1:

- `Deposit` needs no reply channel. `DepositCommand` has no `replyCh`, and `loop` sends no reply.
- There is no drain to forget. The unbuffered send completes when `loop` receives the command.
- `loop` updates `balance` before it handles another message. A later `Withdraw` or `Balance` sees the deposit.
- The type switch is less safe at compile time. `Command any` accepts any value.
- The `switch` has no `default`. An unknown message is dropped with no error.
- If that message has a reply channel, its caller waits forever.
- The closed `request` struct in Approach 1 cannot have the wrong shape.
- The type-switch version saves one line of setup per message, but loses a compile-time guarantee.
- It has one less layer. There is no `response` and `kind` pair shared by all operations.
- `WithdrawCommand` has an `amount` and a reply for `err`. `GetBalanceCommand` has neither amount nor `err`.
- The actor sends a `response` on the `reply` channel in Approach 1.
- This is a style choice, not a correctness or safety change.

## Approach 2: mutex-based, valid but not for this exercise

This does not satisfy the exercise. The README forbids `sync.Mutex` and every other lock. This version uses a mutex.

The behavior tests still pass because they do not inspect the implementation. A plain mutex around `balance` is common in production Go. The comparison is still useful.

```go
package main

import (
	"errors"
	"fmt"
	"sync"
)

// Account is safe for concurrent Deposit/Withdraw/Balance calls from
// many goroutines at once: a mutex guards balance directly, and every
// method holds it for the duration of its check-then-mutate sequence.
type Account struct {
	mu      sync.Mutex
	balance int
}

func NewAccount(initial int) *Account {
	return &Account{balance: initial}
}

func (a *Account) Deposit(amount int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.balance += amount
}

// Withdraw fails with ErrInsufficientFunds rather than letting
// balance go negative. Holding the lock across the check and the
// debit is what makes this atomic under concurrent withdrawals.
func (a *Account) Withdraw(amount int) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if amount > a.balance {
		return ErrInsufficientFunds
	}
	a.balance -= amount
	return nil
}

func (a *Account) Balance() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.balance
}

// Close is a no-op: there's no background goroutine to stop.
func (a *Account) Close() {}

var ErrInsufficientFunds = errors.New("insufficient funds")

func main() {
	account := NewAccount(1000)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account.Deposit(1)
		}()
	}
	wg.Wait()

	fmt.Printf("final balance after 100 concurrent deposits of 1: %d (want 1100)\n", account.Balance())

	if err := account.Withdraw(2000); err != nil {
		fmt.Printf("withdraw correctly rejected: %v\n", err)
	} else {
		fmt.Printf("withdraw of 2000 from a smaller balance was allowed - balance is now %d\n", account.Balance())
	}
}
```

This version fails two checks, not just the lock ban. `TestMainDoesNotUseLocks` fails because the file imports `sync.Mutex`.

I added the no-op `Close` so the code would compile. `TestNewAccountStartsActorGoroutineAndCloseStopsIt` still fails.

`NewAccount` never raises the goroutine count. That is the main structural difference between the two designs.

Here are the concrete differences:

- Resource lifecycle: `Close` closes the actor's `requests` channel. That ends `run`'s range loop and lets the goroutine exit.
- The mutex version has no background work. Its `Close` is a no-op. Its struct needs no cleanup.
- That also means it cannot pass `TestNewAccountStartsActorGoroutineAndCloseStopsIt`. That test requires `NewAccount` to start a goroutine.
- Zero-value use: `var a Account` works with the mutex design. It does not work with the actor design.
- The actor zero value has a nil `a.requests`. A method call blocks forever on that channel. The actor needs `NewAccount`.
- Per-call cost: each actor call sends one message, receives one reply, and allocates a reply channel.
- The mutex version uses one uncontended `Lock` and `Unlock` pair. It is usually cheaper under low contention.
- Message passing does not guarantee FIFO fairness across callers. Channel queue order is a runtime detail, not a Go guarantee.
- `sync.Mutex` allows barging. A new goroutine can take the lock before an older waiter.
- Neither design guarantees caller order. Both prevent lost updates, torn reads, and split check-then-mutate steps.

Use the actor style when you want message passing. Use it when tasks already coordinate by channel or messages form a natural sequence, such as a larger pipeline.

Use a mutex when the state is simple and local. Use it when no background goroutine needs a lifecycle. That fits most bank-account code.

## Key takeaways

- The actor is correct because only `run` touches `balance`. No lock is needed because there is no shared access.
- `Withdraw` gets one-step check and debit from the same rule. Both steps sit in one `case` in one goroutine.
- Every request and reply must finish. `Deposit` looks like it wastes a receive, but skipping `<-reply` stops the actor.
- I removed the receive and ran `TestAccountBasicOperations`. The timeout guard failed it fast.
- The mutex version also solves the concurrency problem. It is common and correct, but this exercise does not ask for it.
- Use an actor for explicit message passing or a background owner. Use a mutex for simple in-process state.
