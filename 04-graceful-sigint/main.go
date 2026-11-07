//////////////////////////////////////////////////////////////////////
//
// A mock process runs forever and blocks the program.
// A SIGINT stops it now, but that is not graceful.
//
// Change the program to do this:
//  1. On the first SIGINT, call proc.Stop().
//  2. On the next SIGINT, exit immediately.
//

package main

func main() {
	proc := MockProcess{}

	proc.Run()
}
