//////////////////////////////////////////////////////////////////////
//
// Rebuild Account with one actor goroutine instead of a mutex.
// The actor owns balance and handles one request at a time.
// Deposit, Withdraw, and Balance send a request and wait for a reply.
// Do not use any lock.
// Withdraw must preserve balance on insufficient funds.
// Close must stop the actor and wait for it to exit.
//
//     func NewAccount(initial int) *Account
//     func (a *Account) Deposit(amount int)
//     func (a *Account) Withdraw(amount int) error
//     func (a *Account) Balance() int
//

package main

import (
	"errors"
	"fmt"
	"sync"
)

// Account stores a balance.
// The naive version has no synchronization.
type Account struct {
	balance int
}

func NewAccount(initial int) *Account {
	return &Account{balance: initial}
}

func (a *Account) Deposit(amount int) {
	a.balance = a.balance + amount
}

// Withdraw must reject amounts above the balance.
// The naive version allows a negative balance.
func (a *Account) Withdraw(amount int) error {
	a.balance = a.balance - amount
	return nil
}

func (a *Account) Balance() int {
	return a.balance
}

// Close does nothing because the naive version starts no goroutine.
// An actor-based Account must stop its actor here.
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
