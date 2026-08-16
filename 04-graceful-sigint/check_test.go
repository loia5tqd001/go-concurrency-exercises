//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// helperProcessEnv, when set in the child's environment, tells
// TestMain to run main() directly instead of the test suite - this
// same compiled test binary re-executes itself as "the program" so
// the tests below can send it real OS signals, the way the exercise
// actually gets exercised (Ctrl-C from a terminal), instead of trying
// to fake signal delivery in-process.
const helperProcessEnv = "GRACEFUL_SIGINT_HELPER_PROCESS"

func TestMain(m *testing.M) {
	if os.Getenv(helperProcessEnv) == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// safeBuffer is an io.Writer safe for concurrent use: the child
// process writes to it from its own OS process (via the pipe backing
// cmd.Stdout/Stderr), while the test goroutine polls its contents.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// child is a running copy of this same test binary, re-executed with
// helperProcessEnv set so it behaves as the program under test.
type child struct {
	cmd  *exec.Cmd
	out  *safeBuffer
	done chan struct{} // closed once cmd.Wait() returns
}

func startChild(t *testing.T) *child {
	t.Helper()

	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperProcessEnv+"=1")

	out := &safeBuffer{}
	cmd.Stdout = out
	cmd.Stderr = out

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start child process: %v", err)
	}

	c := &child{cmd: cmd, out: out, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(c.done)
	}()

	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-c.done
	})

	return c
}

// waitForOutput polls the child's combined stdout/stderr until it
// contains substr, or fails the test if timeout elapses first. Every
// substr checked below comes from mockprocess.go (DO NOT EDIT), never
// from log lines a solution itself chooses to print - so this can
// only ever prove proc.Run()/proc.Stop() were actually reached, not
// enforce any particular logging.
func waitForOutput(t *testing.T, c *child, substr string, timeout time.Duration) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(c.out.String(), substr) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatalf("timed out after %s waiting for output containing %q; got:\n%s", timeout, substr, c.out.String())
}

// TestFirstSigintTriesGracefulStopWithoutExiting sends exactly one
// SIGINT and checks two things: proc.Stop() actually gets called
// (mockprocess.go prints "Stopping process.." once inside it), and
// the program does NOT exit afterwards. The naive scaffold has no
// signal.Notify at all, so the OS's default SIGINT disposition kills
// it on this very first signal - it never reaches Stop() and this
// test fails fast. A solution that calls proc.Stop() synchronously
// (without keeping main free to keep running) would also be
// indistinguishable from "still alive" at this point, since the mock's
// Stop() never returns either way - the second test below is what
// catches that variant.
func TestFirstSigintTriesGracefulStopWithoutExiting(t *testing.T) {
	c := startChild(t)

	waitForOutput(t, c, "Process running", 10*time.Second)
	// Give signal.Notify a moment to register before we send anything -
	// the child only just started the process goroutine.
	time.Sleep(100 * time.Millisecond)

	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("failed to send first SIGINT: %v", err)
	}

	waitForOutput(t, c, "Stopping process", 5*time.Second)

	select {
	case <-c.done:
		t.Fatal("process exited after a single SIGINT; the first signal must only attempt a graceful stop (proc.Stop()), not kill the program")
	case <-time.After(500 * time.Millisecond):
		// Still running, as required.
	}
}

// TestSecondSigintForcesPromptExit sends a first SIGINT (to start the
// graceful stop), waits for proc.Stop() to actually be reached, then
// sends a second SIGINT and requires the program to exit promptly.
// Since the mock's Stop() never returns, any solution that waits on
// it synchronously - or that reads only one signal and never listens
// again - never observes the second SIGINT and hangs forever here,
// which this test catches via a bounded timeout instead of hanging
// itself.
func TestSecondSigintForcesPromptExit(t *testing.T) {
	c := startChild(t)

	waitForOutput(t, c, "Process running", 10*time.Second)
	time.Sleep(100 * time.Millisecond)

	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("failed to send first SIGINT: %v", err)
	}
	waitForOutput(t, c, "Stopping process", 5*time.Second)

	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("failed to send second SIGINT: %v", err)
	}

	const exitTimeout = 5 * time.Second
	select {
	case <-c.done:
		// Exited promptly, as required.
	case <-time.After(exitTimeout):
		t.Fatalf("process did not exit within %s of the second SIGINT; a second SIGINT must kill the program as a last resort, even though proc.Stop() never returns", exitTimeout)
	}
}
