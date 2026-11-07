//////////////////////////////////////////////////////////////////////
//
// Free users get 10 seconds total, not 10 seconds per request.
// Kill the request when free quota runs out.
// Premium users are never killed.
//

package main

// User stores the account type and total processing time.
type User struct {
	ID        int
	IsPremium bool
	TimeUsed  int64 // total seconds used
}

// HandleRequest runs process and reports whether it completed.
func HandleRequest(process func(), u *User) bool {
	process()
	return true
}

func main() {
	RunMockServer()
}
