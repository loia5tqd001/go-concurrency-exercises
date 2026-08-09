//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// TestAccountBasicOperations exercises Deposit, Withdraw, and Balance
// from a single goroutine, so it passes against both the naive and
// the fixed implementation - except for the insufficient-funds check,
// which only the fixed implementation performs.
func TestAccountBasicOperations(t *testing.T) {
	account := NewAccount(100)

	if got := account.Balance(); got != 100 {
		t.Fatalf("initial balance = %d, want 100", got)
	}

	account.Deposit(50)
	if got := account.Balance(); got != 150 {
		t.Fatalf("balance after deposit = %d, want 150", got)
	}

	if err := account.Withdraw(30); err != nil {
		t.Fatalf("Withdraw(30) returned unexpected error: %v", err)
	}
	if got := account.Balance(); got != 120 {
		t.Fatalf("balance after withdraw = %d, want 120", got)
	}

	err := account.Withdraw(1000)
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Errorf("Withdraw(1000) from balance 120 = %v, want ErrInsufficientFunds", err)
	}
	if got := account.Balance(); got != 120 {
		t.Errorf("balance after rejected withdraw = %d, want unchanged 120", got)
	}
}

// TestAccountConcurrentSafety is the key `-race` test. Many goroutines
// deposit concurrently; the naive implementation reads and writes
// balance with no synchronization at all, so the race detector must
// flag a data race on every run, and the final balance is likely to
// be wrong on top of that. The actor implementation serializes all
// access through a single goroutine, so this passes cleanly under
// -race with the exact expected balance.
func TestAccountConcurrentSafety(t *testing.T) {
	const initial = 10000
	const goroutines = 100

	account := NewAccount(initial)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account.Deposit(1)
		}()
	}
	wg.Wait()

	if got, want := account.Balance(), initial+goroutines; got != want {
		t.Errorf("final balance = %d, want %d (exactly initial + %d concurrent deposits of 1)", got, want, goroutines)
	}
}

// TestAccountWithdrawRejectsInsufficientFunds fires more concurrent
// withdrawals than the account can afford and checks that exactly as
// many succeed as the balance allows, with no lost or duplicated
// withdrawals and no negative balance - which requires the actor to
// serialize the check-then-debit sequence atomically per request.
func TestAccountWithdrawRejectsInsufficientFunds(t *testing.T) {
	const initial = 100
	const amount = 30
	const attempts = 5

	account := NewAccount(initial)

	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0

	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := account.Withdraw(amount); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			} else if !errors.Is(err, ErrInsufficientFunds) {
				t.Errorf("Withdraw(%d) returned unexpected error: %v", amount, err)
			}
		}()
	}
	wg.Wait()

	finalBalance := account.Balance()

	if finalBalance < 0 {
		t.Fatalf("final balance went negative: %d", finalBalance)
	}

	if successes > initial/amount {
		t.Errorf("%d withdrawals of %d succeeded, but only %d can fit in a balance of %d",
			successes, amount, initial/amount, initial)
	}

	if want := initial - successes*amount; finalBalance != want {
		t.Errorf("final balance = %d, want %d (initial %d minus %d successful withdrawals of %d)",
			finalBalance, want, initial, successes, amount)
	}
}

// TestAccountCloseStopsActorGoroutine checks that Close actually
// terminates the actor goroutine an actor-based Account starts,
// rather than just existing as a no-op to satisfy the API. It never
// inspects Account's internals - it relies entirely on
// synctest.Test's own rule that every goroutine spawned inside the
// bubble (transitively) must have exited by the time the function
// passed to it returns. NewAccount's actor goroutine, if any, is
// spawned inside this bubble; if Close doesn't make it exit, it's
// still durably blocked (e.g. on <-requests) when this test function
// returns, and synctest.Test panics with a deadlock message instead
// of this test merely failing an assertion.
//
// This passes trivially against the naive, lock-free implementation
// above, which starts no goroutine at all - it only starts pulling
// its weight once Deposit/Withdraw/Balance are backed by an actor.
func TestAccountCloseStopsActorGoroutine(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		account := NewAccount(100)
		defer account.Close()

		account.Deposit(50)
		if got := account.Balance(); got != 150 {
			t.Fatalf("balance = %d, want 150", got)
		}
	})
}

// TestMainDoesNotUseLocks statically rejects any solution that reaches
// for sync.Mutex, sync.RWMutex, sync.Map, or sync/atomic - no behavioral
// test can catch this, since a lock-guarded Account is observationally
// identical to an actor-based one on every property the tests above
// check (serialized access, atomic check-then-debit, correct balances).
// It parses main.go's AST rather than scanning its text, so it isn't
// tripped up by the exercise's own doc comment above mentioning
// "sync.Mutex" in prose, and it flags the identifiers rather than the
// "sync" import itself, since main()'s demo below legitimately uses
// sync.WaitGroup.
func TestMainDoesNotUseLocks(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatalf("parsing main.go: %v", err)
	}

	syncAlias := ""
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		switch path {
		case "sync/atomic":
			t.Fatalf("main.go imports %q - atomic operations bypass the actor goroutine just like a lock would; "+
				"correctness must come purely from serializing access through that single goroutine", path)
		case "sync":
			if imp.Name != nil {
				syncAlias = imp.Name.Name
			} else {
				syncAlias = "sync"
			}
		}
	}
	if syncAlias == "" {
		return
	}

	forbidden := map[string]bool{"Mutex": true, "RWMutex": true, "Map": true}
	ast.Inspect(file, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		ident, ok := sel.X.(*ast.Ident)
		if !ok || ident.Name != syncAlias || !forbidden[sel.Sel.Name] {
			return true
		}
		t.Fatalf("main.go uses %s.%s - no sync.Mutex, sync.RWMutex, or sync.Map (or any other lock) may be used "+
			"anywhere; Account must serialize access purely through its actor goroutine", syncAlias, sel.Sel.Name)
		return true
	})
}

// numGoroutinesToSettle polls runtime.NumGoroutine() until it drops to
// (or below) a threshold, or a deadline passes, and returns whatever it
// last observed. Mirrors the helper in
// 34-prime-sieve/check_test.go, which faces the same need to wait out a
// goroutine's exit without hardcoding a sleep.
func numGoroutinesToSettle(threshold int, timeout time.Duration) int {
	deadline := time.Now().Add(timeout)
	for {
		n := runtime.NumGoroutine()
		if n <= threshold || time.Now().After(deadline) {
			return n
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestNewAccountStartsActorGoroutineAndCloseStopsIt checks the one
// property that actually distinguishes an actor-based Account from a
// mutex-guarded one: the actor owns a long-lived goroutine, and a lock
// does not. TestAccountCloseStopsActorGoroutine above already proves
// Close doesn't leave that goroutine dangling - but its doc comment says
// outright that it passes trivially when no goroutine was ever started,
// which is exactly what a mutex-based Account does. This test closes
// that gap directly: NewAccount must raise the goroutine count by at
// least one, and Close must bring it back down.
func TestNewAccountStartsActorGoroutineAndCloseStopsIt(t *testing.T) {
	before := runtime.NumGoroutine()

	account := NewAccount(100)
	afterNew := runtime.NumGoroutine()
	if afterNew <= before {
		t.Fatalf("goroutine count was %d before NewAccount and %d right after (want it to increase) - "+
			"NewAccount must start a long-lived actor goroutine that owns balance, not just return a "+
			"struct guarded by a lock", before, afterNew)
	}

	account.Close()

	afterClose := numGoroutinesToSettle(before, 500*time.Millisecond)
	if afterClose > before {
		t.Errorf("goroutine count was %d before NewAccount and %d after Close (want it back down to %d) - "+
			"Close must terminate the actor goroutine", before, afterClose, before)
	}
}
