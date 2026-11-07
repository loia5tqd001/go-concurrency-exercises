//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The first settle call must win.
// The second call must return false and not call notify.

func TestCompleteWinsWhenFirst(t *testing.T) {
	var got []string
	r := NewResponder(func(outcome string) { got = append(got, outcome) })

	if !r.Complete("result-A") {
		t.Fatalf("Complete() = false on the first call, want true - nothing has settled this Responder yet")
	}
	if r.Timeout() {
		t.Fatalf("Timeout() = true after Complete already settled the Responder, want false")
	}
	if want := []string{"completed: result-A"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("notify call(s) = %v, want %v - Timeout must not call notify once Complete has already won", got, want)
	}
}

func TestTimeoutWinsWhenFirst(t *testing.T) {
	var got []string
	r := NewResponder(func(outcome string) { got = append(got, outcome) })

	if !r.Timeout() {
		t.Fatalf("Timeout() = false on the first call, want true - nothing has settled this Responder yet")
	}
	if r.Complete("result-B") {
		t.Fatalf("Complete() = true after Timeout already settled the Responder, want false")
	}
	if want := []string{"timed out"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("notify call(s) = %v, want %v - Complete must not call notify once Timeout has already won", got, want)
	}
}

// Many Complete and Timeout calls race on one Responder.
// Exactly one must win, and notify must run once.
func TestSettleRaceExactlyOneWinner(t *testing.T) {
	const rounds = 500
	const contenders = 200

	for round := 0; round < rounds; round++ {
		var notifications, wins int64
		r := NewResponder(func(string) {
			atomic.AddInt64(&notifications, 1)
		})

		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < contenders; i++ {
			i := i
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start

				var won bool
				if i%2 == 0 {
					won = r.Complete("result")
				} else {
					won = r.Timeout()
				}
				if won {
					atomic.AddInt64(&wins, 1)
				}
			}()
		}

		close(start)

		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("round %d: not every Complete/Timeout call returned within 1s", round)
		}

		if n := atomic.LoadInt64(&notifications); n != 1 {
			t.Fatalf("round %d: notify fired %d time(s) out of %d concurrent Complete/Timeout calls, want "+
				"exactly 1 - a Responder must never settle more than once", round, n, contenders)
		}
		if w := atomic.LoadInt64(&wins); w != 1 {
			t.Fatalf("round %d: %d of %d concurrent calls reported winning, want exactly 1", round, w, contenders)
		}
	}
}

// A losing call must return without waiting for notify.
// sync.Once would make the loser wait.
func TestLoserDoesNotBlockOnWinner(t *testing.T) {
	const winnerNotifyDelay = 500 * time.Millisecond
	const loserMustReturnWithin = 150 * time.Millisecond

	winnerStarted := make(chan struct{})
	r := NewResponder(func(string) {
		close(winnerStarted)
		time.Sleep(winnerNotifyDelay) // Simulate a slow side effect.
	})

	go r.Complete("result") // This call should win.

	select {
	case <-winnerStarted:
	case <-time.After(time.Second):
		t.Fatalf("Complete never called notify")
	}

	start := time.Now()
	won := r.Timeout()
	elapsed := time.Since(start)

	if won {
		t.Fatalf("Timeout() = true, want false - Complete already started settling the Responder first")
	}
	if elapsed > loserMustReturnWithin {
		t.Fatalf("Timeout() took %s to return false, want under %s - a losing call must return immediately "+
			"instead of blocking until the winner's notify call finishes", elapsed, loserMustReturnWithin)
	}
}

// Responder must not use sync.Mutex, sync.RWMutex, or sync.Map.
// main may still use sync.WaitGroup.
// This test checks the AST so comments do not affect the result.
func TestMainDoesNotUseLocks(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatalf("parsing main.go: %v", err)
	}

	forbidden := map[string]bool{"Mutex": true, "RWMutex": true, "Map": true}
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == "main" {
			continue
		}

		ast.Inspect(decl, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			ident, ok := sel.X.(*ast.Ident)
			if !ok || ident.Name != "sync" || !forbidden[sel.Sel.Name] {
				return true
			}
			t.Fatalf("main.go uses sync.%s outside of main() - no sync.Mutex, sync.RWMutex, or sync.Map (or any "+
				"other lock) may guard Responder; it must stay lock-free, coordinated purely through sync/atomic",
				sel.Sel.Name)
			return true
		})
	}
}

// The fix must call CompareAndSwap.
// Load, Store, Add, and sync.Once are not enough.
func TestMainUsesCompareAndSwap(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatalf("parsing main.go: %v", err)
	}

	usesAtomic := false
	for _, imp := range file.Imports {
		if path, err := strconv.Unquote(imp.Path.Value); err == nil && path == "sync/atomic" {
			usesAtomic = true
		}
	}
	if !usesAtomic {
		t.Fatalf("main.go does not import sync/atomic - Responder must be made safe with sync/atomic, not a lock")
	}

	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if ok && strings.HasPrefix(sel.Sel.Name, "CompareAndSwap") {
			found = true
		}
		return true
	})

	if !found {
		t.Fatalf("main.go never calls a CompareAndSwap method/function - this exercise is specifically about " +
			"solving Responder's settle-exactly-once race with sync/atomic's compare-and-swap idiom, not just " +
			"Load/Store/Add")
	}
}
