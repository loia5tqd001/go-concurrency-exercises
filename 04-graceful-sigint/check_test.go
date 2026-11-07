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

// helperProcessEnv makes the test binary run main.
// This lets tests send real OS signals to the program.
const helperProcessEnv = "GRACEFUL_SIGINT_HELPER_PROCESS"

func TestMain(m *testing.M) {
	if os.Getenv(helperProcessEnv) == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// safeBuffer lets the child and test share output safely.
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

// child is the test binary running as the program.
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

// waitForOutput waits until child output contains substr.
// The strings come from mockprocess.go, not solution logs.
// The check proves Run or Stop was reached.
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

// TestFirstSigintTriesGracefulStopWithoutExiting sends one SIGINT.
// It checks that Stop runs and the program stays alive.
// The scaffold dies on the first signal.
// Calling Stop synchronously fails the next test.
func TestFirstSigintTriesGracefulStopWithoutExiting(t *testing.T) {
	c := startChild(t)

	waitForOutput(t, c, "Process running", 10*time.Second)
	// Wait for signal.Notify to register inside the child.
	time.Sleep(100 * time.Millisecond)

	if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("failed to send first SIGINT: %v", err)
	}

	waitForOutput(t, c, "Stopping process", 5*time.Second)

	select {
	case <-c.done:
		t.Fatal("process exited after a single SIGINT; the first signal must only attempt a graceful stop (proc.Stop()), not kill the program")
	case <-time.After(500 * time.Millisecond):
	}
}

// TestSecondSigintForcesPromptExit sends two SIGINTs.
// The first starts Stop. The second must end the program.
// Stop never returns, so main cannot wait for it directly.
// The timeout makes a broken solution fail fast.
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
	case <-time.After(exitTimeout):
		t.Fatalf("process did not exit within %s of the second SIGINT; a second SIGINT must kill the program as a last resort, even though proc.Stop() never returns", exitTimeout)
	}
}
