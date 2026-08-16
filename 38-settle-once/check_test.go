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

// TestCompleteWinsWhenFirst and TestTimeoutWinsWhenFirst are the
// uncontended baseline: called one at a time, from a single goroutine,
// the first call to settle a Responder must win and notify exactly
// once; the second call must lose and never call notify at all.

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

// TestSettleRaceExactlyOneWinner is the key correctness test. Each
// round pits many goroutines - half calling Complete, half calling
// Timeout - against the same Responder, all released off the same
// closed channel so they hit the settle point as close to
// simultaneously as the scheduler allows. It checks that notify fired
// EXACTLY once and that exactly one of ALL those calls reports
// winning, no matter which side it came from.
//
// Verified against the naive main.go above: with only two contenders
// (one Complete, one Timeout) this race is too narrow to reliably
// land - the plain bool's read-then-write window is a handful of
// nanoseconds, easy for two goroutines to miss even with no
// synchronization at all. Piling on 100 simultaneous contenders per
// round widens the odds enough that it fails within the first few
// dozen rounds, even without -race. `go test -race` catches the same
// bug even more directly, by flagging the raw unsynchronized
// read/write on r.settled as a data race outright.
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

		close(start) // release every contender at (as close to) the same instant

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

// TestLoserDoesNotBlockOnWinner checks the property that actually
// motivates CompareAndSwap over sync.Once here: a losing call must
// return false immediately, without waiting for the winner's notify
// call to finish. A Responder built on sync.Once would fail this
// test - Once.Do blocks every losing caller on its internal mutex
// until the winning call's function has fully returned, which is
// exactly the wrong behavior for a timeout path whose entire job is
// to bail out fast, not queue behind whatever the winner is doing.
func TestLoserDoesNotBlockOnWinner(t *testing.T) {
	const winnerNotifyDelay = 500 * time.Millisecond
	const loserMustReturnWithin = 150 * time.Millisecond

	winnerStarted := make(chan struct{})
	r := NewResponder(func(string) {
		close(winnerStarted)
		time.Sleep(winnerNotifyDelay) // stand-in for a slow side effect: writing a response, a metric, etc.
	})

	go r.Complete("result") // wins the race; its notify call is now sleeping

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

// TestMainDoesNotUseLocks statically rejects any solution that reaches
// for sync.Mutex, sync.RWMutex, or sync.Map. A mutex-guarded Responder
// would pass every behavioral test above just as well as a lock-free
// one - the whole point of this exercise is practicing sync/atomic's
// compare-and-swap idiom instead of reaching for the same lock this
// repo already covers in 02, 05, 12, 20, 21, 22, 23, 35, 36, 37. It
// parses main.go's AST rather than scanning its text, so it isn't
// tripped up by this file's own doc comments mentioning "sync.Mutex"
// in prose. It inspects every top-level declaration EXCEPT main()
// itself - covering Responder's struct fields, any package-level
// helper var/type, and every method on Responder, wherever a lock
// might be hiding - while leaving main()'s own demo free to use
// sync.WaitGroup; Responder itself must stay lock-free regardless.
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

// TestMainUsesCompareAndSwap statically requires the fix to actually
// call a CompareAndSwap method or function somewhere - not just
// Load/Store, and not sync.Once (which would dodge the lock ban above
// only to reintroduce the exact blocking-loser behavior
// TestLoserDoesNotBlockOnWinner rejects). This exercise is specifically
// about practicing the general "read the current value, compute what
// you'd like to write, install it ONLY IF nothing else changed it
// first" idiom that CompareAndSwap gives you and a plain bool can't.
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
