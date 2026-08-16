//////////////////////////////////////////////////////////////////////
//
// Your video processing service has a freemium model. Every free user
// has 10 sec of processing time total, accumulated across all of their
// requests - not 10s per request. After that, the service kills the
// request, unless the user is a paid premium user.
//

package main

// User defines the UserModel. Use this to check whether a User is a
// Premium user or not
type User struct {
	ID        int
	IsPremium bool
	TimeUsed  int64 // in seconds
}

// HandleRequest runs the processes requested by users. Returns false
// if process had to be killed
func HandleRequest(process func(), u *User) bool {
	process()
	return true
}

func main() {
	RunMockServer()
}
