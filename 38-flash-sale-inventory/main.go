//////////////////////////////////////////////////////////////////////
//
// Store sells a limited number of units of a flash-sale item. Any
// number of unrelated goroutines - one per "buy" request - call Claim
// concurrently, each trying to grab exactly one unit. Right now Claim
// reads and writes stock with no synchronization at all:
//
//	func (s *Store) Claim() bool {
//		if s.stock > 0 {
//			s.stock--
//			return true
//		}
//		return false
//	}
//
//   stock = 1
//   goroutine A: reads stock (1) ──▶ stock>0 ──▶ stock-- ──▶ true
//   goroutine B: reads stock (1) ──▶ stock>0 ──▶ stock-- ──▶ true
//                                       ↑ same last unit, sold twice
//
// Read-then-write are two separate steps. If two goroutines both read
// stock as 1 before either writes, both decrement, both report
// success. The opposite failure shows up too under enough pressure:
// claims go missing, fewer buyers succeed than the stock allows. This
// is the ordinary way a flash-sale endpoint gets hammered the moment
// it goes live.
//
// Your task is to fix Store so that:
//
//   - Claim is safe to call concurrently, from any number of
//     goroutines, and never oversells: the number of calls that
//     return true can never exceed the stock the Store started with.
//   - Claim never loses a claim either: if N units of stock remain,
//     up to N of the concurrently-racing callers must succeed - not
//     fewer.
//   - Remaining always reflects exactly how many units are left.
//
// No sync.Mutex, sync.RWMutex, or any other lock - Claim is a hot path
// on every request, and serializing every caller behind one lock is
// exactly the cost this exercise asks you to avoid. Use sync/atomic's
// CompareAndSwap idiom instead:
//
//   loop:
//     cur := Load(&stock)           read
//     if cur <= 0: return false     check
//     ok := CAS(&stock, cur, cur-1) install - ONLY IF nothing changed
//                                   stock since cur was read
//     if ok: return true
//     else: retry from the top      someone beat us to it - retry
//
// The signatures must stay the same:
//
//	func NewStore(stock int) *Store
//	func (s *Store) Claim() bool
//	func (s *Store) Remaining() int64
//

package main

import (
	"fmt"
	"sync"
)

// Store sells a limited number of units of a single flash-sale item.
// Claim is supposed to be safe for concurrent calls from any number
// of goroutines, but right now it is not: stock is read and written
// with no synchronization at all, so concurrent calls race on it -
// oversold units, lost claims, or both.
type Store struct {
	stock int64
}

// NewStore returns a Store with stock units available to claim.
func NewStore(stock int) *Store {
	return &Store{stock: int64(stock)}
}

// Claim tries to grab one unit of stock, reporting whether it
// succeeded. Once stock reaches zero, every subsequent call returns
// false and no more units are ever handed out.
func (s *Store) Claim() bool {
	if s.stock > 0 {
		s.stock--
		return true
	}
	return false
}

// Remaining reports how many units are left unclaimed.
func (s *Store) Remaining() int64 {
	return s.stock
}

func main() {
	const stock = 5
	const buyers = 50

	store := NewStore(stock)

	var claimed int
	var mu sync.Mutex // only used by main() to collect results, not by Store itself

	var wg sync.WaitGroup
	for i := 0; i < buyers; i++ {
		i := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			if store.Claim() {
				mu.Lock()
				claimed++
				mu.Unlock()
				fmt.Printf("buyer %d: claimed a unit\n", i)
			} else {
				fmt.Printf("buyer %d: sold out\n", i)
			}
		}()
	}
	wg.Wait()

	fmt.Printf("%d buyer(s) claimed a unit out of %d units of stock (want exactly %d), %d remaining\n",
		claimed, stock, stock, store.Remaining())
}
