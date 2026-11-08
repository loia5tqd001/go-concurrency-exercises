// 04 is a state problem, not a timing problem: what is alive, whether
// proc.Stop() runs, and whether a second Ctrl-C still has a listener. Every
// scene models one run of TestSecondSigintForcesPromptExit: the test sends
// SIGINT, waits for "Stopping process", then sends SIGINT again. The other
// test's run sends only one SIGINT and then watches for 500 ms, so no scene
// here can reach its verdict, and no scene names it.
//
// The OS node is the signal source. It cannot see main's code: it checks only
// whether signal.Notify registered a channel. With no channel, a SIGINT takes
// the default action and the process exits; with one, the OS hands the signal
// to that channel and never blocks.

import { channel, defineViz, exit, go, goroutine, notify, onRecv, recv, select, sleep, work } from "../engine/ops.ts";
import type { NodeDef, Self, TestDef } from "../engine/model.ts";

// The scaffold and README name no buffer size and no exit code, so the
// solution doc is the source for those two numbers.
const K = {
  signalCap: { value: 2, file: "../solutions/04-graceful-sigint.md", text: "sigChan := make(chan os.Signal, 2)" },
  exitCode: { value: 1, file: "../solutions/04-graceful-sigint.md", text: "os.Exit(1)" },
  settleMs: { value: 100, file: "check_test.go", text: "time.Sleep(100 * time.Millisecond)" },
  pollMs: { value: 10, file: "check_test.go", text: "time.Sleep(10 * time.Millisecond)" },
  exitTimeoutS: { value: 5, file: "check_test.go", text: "const exitTimeout = 5 * time.Second" },
} as const;

// The test sends two SIGINTs: one, then one more after "Stopping process".
const SIGINTS = 2;
const EXIT = `os.Exit(${K.exitCode.value})`;

// The second SIGINT goes out one poll after Stop prints, and the test then
// waits exitTimeout for the process to end.
const SECOND_AT = K.settleMs.value + K.pollMs.value;
const GIVE_UP_AT = SECOND_AT + K.exitTimeoutS.value * 1000;

const tests: Record<string, TestDef> = {
  second: {
    name: "TestSecondSigintForcesPromptExit",
    short: "2nd signal exit",
    // Stop was reached, both SIGINTs went out, and the process ended.
    judge: (run) => run.outcome === "exit" && run.vars.stopping === 1 && run.vars.sent === SIGINTS,
  },
};

// The test process sending SIGINT through the OS.
function* osProgram({ vars }: Self) {
  // waitForOutput("Process running") returns at once, then the test gives
  // signal.Notify a moment to register.
  yield sleep(K.settleMs.value);
  for (let n = 1; n <= SIGINTS; n++) {
    vars.sent = n;
    // No channel registered: SIGINT's default action ends the process.
    if (vars.notify !== 1) {
      yield exit("SIGINT");
      return;
    }
    yield notify("sigChan", "^C");
    // waitForOutput("Stopping process"): check, then sleep, until it shows.
    if (n < SIGINTS) while (vars.stopping !== 1) yield sleep(K.pollMs.value);
  }
}

const OS = (): NodeDef => goroutine({ label: "OS", pos: [0, 0], program: osProgram });

// go proc.Run(): it prints "Process running.." and then a dot a second forever.
const RUN = (pos: readonly [number, number]): NodeDef =>
  goroutine({
    label: "proc.Run()",
    pos,
    spawned: true,
    program: function* () {
      yield work(Infinity, "Process running", { at: "proc.Run()" });
    },
  });

// proc.Stop() prints "Stopping process.." and then a dot a second forever.
function* stopCall(vars: Record<string, number>, at?: string) {
  vars.stopping = 1;
  yield work(Infinity, "Stopping process", at === undefined ? {} : { at });
}

export default defineViz({
  schema: 3,
  exercise: "04-graceful-sigint",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:87b55269", goal: "fnv1a:87b55269" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: "main runs proc.Run() and never listens for signals. The first Ctrl-C ends the process at once.",
      model: {
        nodes: {
          os: OS(),
          main: goroutine({
            label: "main",
            pos: [2, 0],
            main: true,
            program: function* () {
              yield work(Infinity, "Process running", { at: "proc.Run()" });
            },
          }),
        },
        insight:
          "main stays in proc.Run() forever. Nothing listens for SIGINT. The first Ctrl-C takes the OS default, so the process dies mid-work. proc.Stop() never runs, and the test never sees \"Stopping process\".",
        stops: [
          {
            when: { op: "exit" },
            say: "The first Ctrl-C arrives. Nothing handles SIGINT, so the OS ends the process. proc.Stop() never runs.",
          },
        ],
        tests,
        code: {
          file: "main.go",
          text: `
@main func main() {
@main 	proc := MockProcess{}
@main
@main 	proc.Run()
@main }`,
        },
        expect: { outcome: "exit", tests: { second: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "The first Ctrl-C starts proc.Stop() on another goroutine. The process keeps running. The second Ctrl-C ends it at once.",
      model: {
        nodes: {
          os: OS(),
          sigChan: channel({ label: "SIGINT", pos: [1, 0], cap: K.signalCap.value }),
          main: goroutine({
            label: "main",
            pos: [2, 0],
            main: true,
            program: function* ({ vars }) {
              yield go("run");
              // signal.Notify: from now on the OS sends SIGINT to the channel.
              vars.notify = 1;
              yield recv("sigChan");
              yield go("stop");
              yield recv("sigChan");
              yield exit(EXIT);
            },
          }),
          run: RUN([2, 1]),
          stop: goroutine({
            label: "proc.Stop()",
            pos: [3, 0],
            spawned: true,
            program: function* ({ vars }) {
              yield* stopCall(vars);
            },
          }),
        },
        insight:
          "The OS now sends each Ctrl-C to a channel. It does not kill the process. proc.Stop() runs on another goroutine and never returns. main stays free, so the second Ctrl-C reaches it and ends the program.",
        stops: [
          {
            when: { op: "go", g: "main", nth: 2 },
            say: "The first Ctrl-C reaches main. main starts proc.Stop() on another goroutine, so main can still listen.",
          },
          {
            when: { op: "exit" },
            say: "The second Ctrl-C reaches main while proc.Stop() still runs. main ends the program.",
          },
        ],
        tests,
        expect: { outcome: "exit", tests: { second: "pass" } },
      },
    },
    {
      id: "trap",
      chip: "Trap",
      tier: "inside",
      summary: "main calls proc.Stop() itself. Stop never returns. The second Ctrl-C waits in sigChan unread, so the process never exits.",
      model: {
        nodes: {
          os: OS(),
          sigChan: channel({ label: "sigChan", pos: [1, 0], cap: K.signalCap.value }),
          main: goroutine({
            label: "main",
            pos: [2, 0],
            main: true,
            program: function* ({ vars }) {
              yield go("run");
              vars.notify = 1;
              yield recv("sigChan");
              // proc.Stop() on main, not on its own goroutine.
              yield* stopCall(vars);
            },
          }),
          run: RUN([2, 1]),
        },
        insight: `Calling proc.Stop() on main looks right. But Stop never returns, so main never reads sigChan again. The second Ctrl-C sits in the buffer. After ${K.exitTimeoutS.value} s, the test gives up.`,
        stops: [
          {
            when: { op: "work", g: "main" },
            say: "The first Ctrl-C wakes main. main calls proc.Stop() itself. Stop never returns.",
          },
          {
            // Counted after stop 1, so this is the 2nd SIGINT.
            when: { op: "notify" },
            say: "The second Ctrl-C lands in sigChan's buffer. main is inside Stop, so nobody reads it.",
          },
        ],
        tests,
        clock: { unit: "ms" },
        until: GIVE_UP_AT,
        expect: { outcome: "timeout", t: GIVE_UP_AT, tests: { second: "fail" } },
      },
    },
    {
      id: "fixed",
      chip: "Fixed",
      tier: "inside",
      summary: `proc.Stop() runs on another goroutine. main waits in select on stopped and sigChan. The second Ctrl-C reaches ${EXIT}.`,
      model: {
        nodes: {
          os: OS(),
          sigChan: channel({ label: "sigChan", pos: [1, 0], cap: K.signalCap.value }),
          main: goroutine({
            label: "main",
            pos: [2, 0],
            main: true,
            program: function* ({ vars }) {
              yield go("run");
              vars.notify = 1;
              yield recv("sigChan");
              yield go("stop");
              const r: { i: number } = yield select([onRecv("stopped"), onRecv("sigChan")]);
              if (r.i === 1) yield exit(EXIT, { at: EXIT });
            },
          }),
          run: RUN([2, 1]),
          // stopped sits right of main and Stop beyond it: Stop would close
          // stopped, and main reads it. Row 0 keeps the channel's label clear
          // of the edge when the grid turns on a narrow screen.
          stopped: channel({ label: "stopped", pos: [3, 0], cap: 0 }),
          stop: goroutine({
            label: "proc.Stop()",
            pos: [4, 1],
            spawned: true,
            program: function* ({ vars }) {
              yield* stopCall(vars, "proc.Stop()");
              // close(stopped) would run here, but Stop never returns.
            },
          }),
        },
        // On a narrow screen the straight go edge would cut stopped's label.
        routes: { "main>stop": "above" },
        insight: `select lets main wait for two things. It can wait for Stop to close stopped. It can also wait for a second Ctrl-C on sigChan. Stop never returns, so the second Ctrl-C wins. Then ${EXIT} ends the program.`,
        stops: [
          {
            when: { op: "go", g: "main", nth: 2 },
            say: "The first Ctrl-C makes main start proc.Stop() on another goroutine. Then main waits in select on stopped and sigChan.",
          },
          {
            when: { op: "exit" },
            say: `The second Ctrl-C wins the select. ${EXIT} ends the program, even though proc.Stop() is still running.`,
          },
        ],
        tests,
        code: {
          file: "solution",
          text: `
@main func main() {
…
@main,run 	go proc.Run()
…
@main 	sigChan := make(chan os.Signal, 2)
@main 	signal.Notify(sigChan, os.Interrupt)
…
@main 	<-sigChan
…
@main 	stopped := make(chan struct{})
@main 	go func() {
@stop 		proc.Stop()
@stop 		close(stopped)
@main 	}()
…
@main 	select {
@main 	case <-stopped:
@main 		fmt.Println("Process gracefully stopped")
@main 	case <-sigChan:
@main 		fmt.Println("Second signal received, killing process")
@main 		os.Exit(1)
@main 	}
@main }`,
        },
        expect: { outcome: "exit", tests: { second: "pass" } },
      },
    },
  ],
});
