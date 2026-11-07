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

// callTimeout prevents a stuck actor from hanging the suite.
// One stuck request would block every later request.
const callTimeout = 2 * time.Second

// depositWithTimeout prevents Deposit from hanging the test.
func depositWithTimeout(t *testing.T, account *Account, amount int) {
	t.Helper()

	done := make(chan struct{}, 1)
	go func() {
		account.Deposit(amount)
		done <- struct{}{}
	}()

	select {
	case <-done:
	case <-time.After(callTimeout):
		t.Fatalf("Deposit(%d) did not return within %s - a wedged actor goroutine blocks every future call too", amount, callTimeout)
	}
}

// withdrawWithTimeout prevents Withdraw from hanging the test.
func withdrawWithTimeout(t *testing.T, account *Account, amount int) error {
	t.Helper()

	done := make(chan error, 1)
	go func() { done <- account.Withdraw(amount) }()

	select {
	case err := <-done:
		return err
	case <-time.After(callTimeout):
		t.Fatalf("Withdraw(%d) did not return within %s - a wedged actor goroutine blocks every future call too", amount, callTimeout)
		return nil
	}
}

// balanceWithTimeout prevents Balance from hanging the test.
func balanceWithTimeout(t *testing.T, account *Account) int {
	t.Helper()

	done := make(chan int, 1)
	go func() { done <- account.Balance() }()

	select {
	case b := <-done:
		return b
	case <-time.After(callTimeout):
		t.Fatalf("Balance() did not return within %s - a wedged actor goroutine blocks every future call too", callTimeout)
		return 0
	}
}

// closeWithTimeout prevents Close from hanging the test.
func closeWithTimeout(t *testing.T, account *Account) {
	t.Helper()

	done := make(chan struct{}, 1)
	go func() {
		account.Close()
		done <- struct{}{}
	}()

	select {
	case <-done:
	case <-time.After(callTimeout):
		t.Fatalf("Close() did not return within %s - it must terminate the actor goroutine, not wait on it forever", callTimeout)
	}
}

// TestAccountBasicOperations checks basic balance changes.
// It also checks an overdraft is rejected without changing balance.
func TestAccountBasicOperations(t *testing.T) {
	account := NewAccount(100)

	if got := balanceWithTimeout(t, account); got != 100 {
		t.Fatalf("initial balance = %d, want 100", got)
	}

	depositWithTimeout(t, account, 50)
	if got := balanceWithTimeout(t, account); got != 150 {
		t.Fatalf("balance after deposit = %d, want 150", got)
	}

	if err := withdrawWithTimeout(t, account, 30); err != nil {
		t.Fatalf("Withdraw(30) returned unexpected error: %v", err)
	}
	if got := balanceWithTimeout(t, account); got != 120 {
		t.Fatalf("balance after withdraw = %d, want 120", got)
	}

	err := withdrawWithTimeout(t, account, 1000)
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Errorf("Withdraw(1000) from balance 120 = %v, want ErrInsufficientFunds", err)
	}
	if got := balanceWithTimeout(t, account); got != 120 {
		t.Errorf("balance after rejected withdraw = %d, want unchanged 120", got)
	}
}

// TestAccountConcurrentSafety runs many concurrent deposits.
// The final balance must be exact. Use 1000 goroutines to expose lost updates.
func TestAccountConcurrentSafety(t *testing.T) {
	const initial = 10000
	const goroutines = 1000

	account := NewAccount(initial)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			account.Deposit(1)
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(callTimeout):
		t.Fatalf("%d concurrent deposits did not finish within %s - a wedged actor goroutine blocks every caller", goroutines, callTimeout)
	}

	if got, want := balanceWithTimeout(t, account), initial+goroutines; got != want {
		t.Errorf("final balance = %d, want %d (exactly initial + %d concurrent deposits of 1)", got, want, goroutines)
	}
}

// TestAccountWithdrawRejectsInsufficientFunds runs too many withdrawals.
// The count and balance must match successful withdrawals.
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

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(callTimeout):
		t.Fatalf("%d concurrent withdrawals did not finish within %s - a wedged actor goroutine blocks every caller", attempts, callTimeout)
	}

	finalBalance := balanceWithTimeout(t, account)

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

// TestAccountCloseStopsActorGoroutine requires every started goroutine to exit.
// synctest fails if Close leaves the actor blocked.
// The naive version passes because it starts no goroutine.
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

// TestMainDoesNotUseLocks rejects locks and atomic operations.
// It parses the AST so comments and normal sync.WaitGroup use are allowed.
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

// numGoroutinesToSettle waits for the goroutine count to drop.
// It returns the last count when the deadline expires.
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

// TestNewAccountStartsActorGoroutineAndCloseStopsIt checks the goroutine lifecycle.
// NewAccount must start one goroutine, and Close must stop it.
func TestNewAccountStartsActorGoroutineAndCloseStopsIt(t *testing.T) {
	before := runtime.NumGoroutine()

	account := NewAccount(100)
	afterNew := runtime.NumGoroutine()
	if afterNew <= before {
		t.Fatalf("goroutine count was %d before NewAccount and %d right after (want it to increase) - "+
			"NewAccount must start a long-lived actor goroutine that owns balance, not just return a "+
			"struct guarded by a lock", before, afterNew)
	}

	closeWithTimeout(t, account)

	afterClose := numGoroutinesToSettle(before, 500*time.Millisecond)
	if afterClose > before {
		t.Errorf("goroutine count was %d before NewAccount and %d after Close (want it back down to %d) - "+
			"Close must terminate the actor goroutine", before, afterClose, before)
	}
}
