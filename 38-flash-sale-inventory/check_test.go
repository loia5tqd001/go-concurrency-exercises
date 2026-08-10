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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// TestClaimSequentialBaseline is the uncontended baseline: from a
// single goroutine, Claim must succeed exactly `stock` times, with
// Remaining tracking the exact count after each one, and then start
// reporting sold out.
func TestClaimSequentialBaseline(t *testing.T) {
	const stock = 5
	s := NewStore(stock)

	for i := 0; i < stock; i++ {
		if !s.Claim() {
			t.Fatalf("Claim %d/%d was rejected, but stock should still be available", i+1, stock)
		}
		if got, want := s.Remaining(), int64(stock-i-1); got != want {
			t.Fatalf("Remaining() after claim %d = %d, want %d", i+1, got, want)
		}
	}

	if s.Claim() {
		t.Fatalf("Claim succeeded after every unit had already been claimed - store should report sold out")
	}
	if got := s.Remaining(); got != 0 {
		t.Errorf("Remaining() after sellout = %d, want 0", got)
	}
}

// TestClaimNeverOversellsOrLoses is the key correctness test. It fires
// far more concurrent Claim calls than there is stock, across several
// rounds, and checks that the number of successful claims is EXACTLY
// equal to the stock every single time - no oversell (successes >
// stock, the naive version's failure mode: an unsynchronized read of
// s.stock followed by an unsynchronized write lets two goroutines both
// see the same last unit as available and both decrement it) and no
// lost claims either (successes < stock, which an overly-defensive
// wrong fix could produce instead).
//
// Verified against the naive main.go above: fails on every one of 10
// consecutive runs, even without -race, once there's enough
// concurrent pressure - this unsynchronized check-then-decrement race
// is one of the most reliably reproducible concurrency bugs there is.
// `go test -race` catches it even more directly, by flagging the raw
// unsynchronized read/write on s.stock as a data race outright.
func TestClaimNeverOversellsOrLoses(t *testing.T) {
	const stock = 200
	const goroutines = 4000
	const rounds = 5

	for round := 0; round < rounds; round++ {
		s := NewStore(stock)
		var successes int64

		var wg sync.WaitGroup
		for i := 0; i < goroutines; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if s.Claim() {
					atomic.AddInt64(&successes, 1)
				}
			}()
		}
		wg.Wait()

		if successes != stock {
			t.Fatalf("round %d: %d Claim call(s) succeeded out of %d concurrent attempts against a stock of %d - "+
				"want exactly %d successes, no more (oversold) and no fewer (lost claims)",
				round, successes, goroutines, stock, stock)
		}
		if got := s.Remaining(); got != 0 {
			t.Fatalf("round %d: Remaining() = %d after every unit was claimed, want 0", round, got)
		}
	}
}

// TestMainDoesNotUseLocks statically rejects any solution that reaches
// for sync.Mutex, sync.RWMutex, or sync.Map. A mutex-guarded Store
// would pass every behavioral test above just as well as a lock-free
// one - the whole point of this exercise is practicing sync/atomic's
// compare-and-swap idiom instead of reaching for the same lock this
// repo already covers in 02, 05, 12, 20, 21, 22, 23, 35, 36, 37. It
// parses main.go's AST rather than scanning its text, so it isn't
// tripped up by this file's own doc comments mentioning "sync.Mutex"
// in prose. It inspects every top-level declaration EXCEPT main()
// itself - covering Store's struct fields, any package-level helper
// var/type, and every method on Store, wherever a lock might be
// hiding - while leaving main()'s own demo free to use sync.WaitGroup
// (and, harmlessly, a sync.Mutex of its own just to collect results;
// that mutex belongs to main(), not to Store, so it's not what this
// check guards against - Store's own Claim/Remaining must stay
// lock-free regardless).
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
				"other lock) may guard Store; it must stay lock-free, coordinated purely through sync/atomic", sel.Sel.Name)
			return true
		})
	}
}

// TestMainUsesCompareAndSwap statically requires the fix to actually
// call a CompareAndSwap method or function somewhere - not just
// Load/Store, and not atomic.AddInt64 undone with a compensating +1
// on failure. That undo-on-failure trick happens to work here because
// decrementing by exactly one is trivially reversible, but it's a
// dead end the moment an update isn't a fixed additive delta - which
// is exactly why this exercise exists: to practice the general "read
// the current value, compute what you'd like to write, install it
// ONLY IF nothing else changed it first, retry if something did" loop
// that CompareAndSwap gives you, and that plain arithmetic can't.
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
		t.Fatalf("main.go does not import sync/atomic - Store must be made safe with sync/atomic, not a lock")
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
			"solving Claim's floor-at-zero conditional decrement with sync/atomic's compare-and-swap idiom, " +
			"not just Load/Store/Add")
	}
}
