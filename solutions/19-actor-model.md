# Actor Model: A Bank Account With No Locks — Suggested Solutions

> **Spoiler warning.** This file contains full worked solutions for `19-actor-model/`. Try solving it yourself first — come back here if you're stuck or want to compare approaches.

## The problem

`Account` must be safe for concurrent `Deposit`/`Withdraw`/`Balance` calls from many goroutines. The task specifically asks for the "share memory by communicating" style: `NewAccount` starts a single long-lived goroutine that owns `balance` and processes one request at a time from an unexported channel; `Deposit`, `Withdraw`, and `Balance` become thin methods that send a request and block on a reply channel. The README is explicit that **no `sync.Mutex` (or any other lock) may be used anywhere** — this exercise is about practicing message-passing, not just about making `Account` thread-safe by any means.

`Withdraw` must also return `ErrInsufficientFunds`, leaving `balance` unchanged, if `amount` exceeds `balance` at the moment the request is processed — and that check-then-debit must be atomic even under concurrent withdrawal attempts (`TestAccountWithdrawRejectsInsufficientFunds` fires 5 concurrent withdrawals of 30 against a balance of 100 and requires that no more than 3 succeed, with the exact resulting balance and no negative balance).

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

`balance` is read and written directly with zero synchronization, and `Withdraw` doesn't even check funds. Verified directly against this test suite, running `go test -race ./...` on the naive version fails in multiple, compounding ways:

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

`Withdraw(1000)` from a balance of 120 is wrongly allowed, driving the balance to -880. Concurrent deposits lose updates (final balance 10836 instead of 11000, from 1000 concurrent `+1`s on an initial 10000), the race detector flags the unsynchronized read/write on `balance`, unchecked concurrent withdrawals push the balance negative (-50) since there's no atomicity around "check funds, then debit," and `NewAccount` never starts a goroutine at all since there's no actor to serialize through.

## Approach 1: actor goroutine (message-passing, no locks)

A single goroutine (`run`) owns `balance` as a plain local variable — never shared, never touched by any other goroutine — and processes `request` values one at a time from an unbuffered channel. Since only one goroutine ever reads or writes `balance`, and it processes requests strictly sequentially, there's nothing left to race on and no lock is needed.

```go
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

**Verified**: `go test -race -count=20 ./...` passes 20/20 with no races and the exact expected balances, including the insufficient-funds test (no more than `initial/amount` withdrawals ever succeed, balance never goes negative) and both `Close`-related tests (the actor goroutine visibly starts in `NewAccount` and is gone again after `Close`).

Two correctness details worth calling out because they're easy to get wrong when hand-rolling this pattern:

- The `check_test.go` for `Withdraw` requires the funds check and the debit to be atomic together. That falls out for free here: both happen inside the same `case opWithdraw:` in the single actor goroutine, so no other request can interleave between the check and the debit — there's no separate lock to "hold across" the sequence, because there's only ever one goroutine touching `balance` in the first place.
- `Deposit` sends its request and then unconditionally waits on `<-reply`, even though it discards the result. This isn't optional bookkeeping — `req.reply <- response{...}` inside `run` is a *send* on an unbuffered channel, so if `Deposit` didn't receive it, the actor goroutine would block forever trying to reply to the first deposit and the entire account would wedge. Verified directly: deleting the `<-reply` line and re-running `TestAccountBasicOperations` reports `Balance() did not return within 2s - a wedged actor goroutine blocks every future call too` in about two seconds, confirming the drain is load-bearing, not decorative — `check_test.go`'s timeout guards turn what would otherwise be a wedged, minutes-long hang into that fast, readable failure.

## Approach 1b: actor goroutine with typed messages instead of a tagged struct

Same idea as Approach 1 — a single actor goroutine owns `balance` as a local variable, no locks anywhere — but the message shape is different: instead of one `request` struct with a `kind` enum field, each operation gets its own concrete message type, and the actor `switch`es on the message's dynamic type rather than an `int`.

```go
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

**Verified**: `go test -race -count=20 ./...` passes 20/20, including both `Close`-related tests.

Versus Approach 1:

- **`Deposit` needs no reply channel at all.** `DepositCommand` carries no `replyCh`, and `loop` never tries to send one back for it. This sidesteps Approach 1's documented gotcha entirely — there's no drain to forget, because there's nothing to drain. Correctness doesn't depend on remembering the drain; it falls out of the same unbuffered-channel rendezvous that makes any of these designs work: `Deposit`'s send only completes once `loop` receives it, and `loop` finishes that `case` (updating `balance`) before it goes back to ranging for the next message, so any later `Withdraw`/`Balance` call is guaranteed to see the deposit.
- **Weaker compile-time safety.** `Command any` accepts any value, and the `switch` has no `default` — a message of a type nobody handles is silently dropped instead of causing a compile error, and if that dropped message carried a reply channel, its caller blocks forever. Approach 1's closed `request` struct can't be constructed with the wrong shape in the first place. This is a real cost of the type-switch style, not just a style preference — it trades a compile-time guarantee for one line less boilerplate per message type.
- **One fewer indirection to reason about.** There's no `response`/`kind` pair shared across three unrelated operations — each message's fields are exactly what that operation needs (`WithdrawCommand` has an `amount` and an `err`-shaped reply, `GetBalanceCommand` has neither `amount` nor `err`). Whether that's clearer or just "different boilerplate" is a matter of taste; unlike the two points above, it isn't a correctness or safety difference.

## Approach 2: mutex-based (also valid — but not for this exercise)

This does **not** satisfy the exercise: the README explicitly forbids `sync.Mutex` (or any lock) here, and this approach uses one directly, so it fails the letter of the assignment even though the tests (which don't inspect implementation, only behavior) pass against it. It's included because a plain mutex guarding `balance` is how this exact problem is solved in most production Go code, and it's worth understanding both the parity and the differences.

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

**Verified**: this one now fails the suite on two separate grounds, not just the letter-of-the-assignment one the paragraph above already calls out: `TestMainDoesNotUseLocks` fails as expected (it imports `sync.Mutex`), and — even with the no-op `Close` above added just to make it compile — `TestNewAccountStartsActorGoroutineAndCloseStopsIt` also fails, because `NewAccount` never raises the goroutine count the way an actor's `NewAccount` must. That second failure isn't a technicality: it's the same property the "concrete differences" list below already named as the structural difference between the two approaches, now enforced by a test rather than left as prose.

Concrete differences worth knowing, all readable straight off the two implementations above:

- **Resource lifecycle.** The actor's `requests` channel is closed by `Close`, which ends `run`'s range loop and lets the goroutine exit. The mutex version has nothing to leak or clean up — it's just a struct, so its `Close` is a no-op — but that also means it can never satisfy `TestNewAccountStartsActorGoroutineAndCloseStopsIt`, which requires `NewAccount` to visibly start a goroutine.
- **Zero value usability.** `var a Account` is a perfectly usable, empty mutex-based account. The actor version's zero value is not: `a.requests` is a nil channel, so any method call blocks forever sending on it. `NewAccount` is mandatory for the actor version in a way it isn't for the mutex version.
- **Per-call cost.** Each actor call does two channel operations (one send, one receive) plus a `reply` channel allocation; the mutex version does one uncontended `Lock`/`Unlock` pair, which is typically cheaper per call, especially under low contention.
- **What doesn't differ:** don't read "message passing" as buying you FIFO fairness across callers — Go's channel send-queue ordering is a runtime implementation detail, not a language guarantee, and `sync.Mutex` explicitly allows barging (a newly-arriving goroutine can grab the lock ahead of one that's been waiting). Neither approach gives you an ordering guarantee here; both just give you correctness (no lost updates, no torn reads, atomic check-then-mutate).

When to reach for which: use the actor style when you want to practice or lean into "share memory by communicating," when the owned state needs to coordinate with other goroutines via the same channel-based protocol anyway, or when the operations naturally compose as a sequence of messages (e.g. feeding into a larger pipeline). Use a mutex when the state is simple, contained, and doesn't need a background goroutine's lifecycle — which describes most bank-account-shaped problems in real code, and is exactly why this is billed as "also valid," not a lesser answer.

## Key takeaways

- Correctness in the actor approach comes entirely from the invariant that exactly one goroutine (`run`) ever touches `balance`; there's no lock because there's no shared access to protect in the first place.
- `Withdraw`'s check-then-debit atomicity falls out for free from that same invariant — both steps happen in one `case` inside the single-threaded actor loop, with no other request able to interleave.
- Every request/reply round trip in the actor must actually complete: `Deposit` looks like it wastes a receive on a value it discards, but skipping `<-reply` deadlocks the actor on the very next unbuffered send — verified empirically by removing it and watching `TestAccountBasicOperations` fail fast on `check_test.go`'s timeout guard instead of running to Go's default 10-minute test timeout.
- The mutex-based version is a real, commonly-reached-for, equally correct solution to the underlying concurrency problem — it just isn't what this exercise is asking you to practice. Know both: the actor pattern for when you want explicit message-passing semantics or a coordinating background goroutine, and a mutex for the common case where you just need to guard some in-process state.
