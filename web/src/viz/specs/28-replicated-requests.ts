// 28 is a cancellation problem with two README fences. Today hands every
// replica a nil done, so the losers run out their full timers; Goal hands them
// stop, so they return the instant replica-B wins. Two fences give two doors,
// and each Problem tier pins its own.
//
// Today, Goal, Winner, and Leak model main(): replica-A, B, and C with the
// latencies main.go gives them. Cancel models
// TestFetchFastestClosedDoneCancelsEarly, whose replicas are "a" and "b".
//
// FetchFastest starts its replicas with one go statement in a loop, so they
// are one group node: replica-1, 2, and 3 are replica-A, B, and C, and each
// one's value (A, B, C) names it. Three separate rows would not fit the
// narrow pane: three lanes leave each box too narrow for its status.
//
// Each replica runs mockreplica.go: it starts its own timer, then waits on the
// timer or its done. Its deferred timer.Stop() is drawn only when done won:
// after the timer fired, Stop changes nothing in Go.

import { channel, close, defineViz, go, goroutine, onRecv, select, send, sleep, start, stop, timer } from "../engine/ops.ts";
import type { Model, NodeDef, Self, TestDef } from "../engine/model.ts";

const K = {
  aMs: { value: 150, file: "main.go", text: 'NewMockReplica("replica-A", 150*time.Millisecond)' },
  bMs: { value: 10, file: "main.go", text: 'NewMockReplica("replica-B", 10*time.Millisecond)' },
  cMs: { value: 300, file: "main.go", text: 'NewMockReplica("replica-C", 300*time.Millisecond)' },
  demoSleepMs: { value: 400, file: "main.go", text: "time.Sleep(400 * time.Millisecond)" },
  fixedSleepMs: { value: 20, file: "../solutions/28-replicated-requests.md", text: "time.Sleep(20 * time.Millisecond)" },
  testAMs: { value: 50, file: "check_test.go", text: 'r1 := NewMockReplica("a", 50*time.Millisecond)' },
  testBMs: { value: 100, file: "check_test.go", text: 'r2 := NewMockReplica("b", 100*time.Millisecond)' },
  checkMs: { value: 5, file: "check_test.go", text: "time.Sleep(5 * time.Millisecond)" },
  drainMs: { value: 150, file: "check_test.go", text: "time.Sleep(150 * time.Millisecond)" },
} as const;

interface ReplicaDef {
  timer: string;
  ms: number;
  // The replica's value, shortened: its name is its value.
  v: string;
}

// main()'s three replicas, in the order main.go lists them.
const DEMO: readonly ReplicaDef[] = [
  { timer: "timerA", ms: K.aMs.value, v: "A" },
  { timer: "timerB", ms: K.bMs.value, v: "B" },
  { timer: "timerC", ms: K.cMs.value, v: "C" },
];

// TestFetchFastestClosedDoneCancelsEarly's two replicas.
const TEST: readonly ReplicaDef[] = [
  { timer: "timerA", ms: K.testAMs.value, v: "a" },
  { timer: "timerB", ms: K.testBMs.value, v: "b" },
];

// The grid. The answer climbs from replica to results and runs right to the
// caller; the caller's close of stop (nil today) drops down-left to stop and
// runs back to the replicas. The close arrow meets stop from the side, so it
// crosses neither stop's name above nor "closed" below. Every edge stays
// straight at both widths.
const TIMER_POS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
];
const POS = {
  replica: [1.5, 1],
  results: [2, 0],
  stop: [2.5, 1],
  caller: [3, 0],
  done: [4, 0],
} as const;

// go func(r Replica) { value, err := r(done); results <- ... }(replica), with
// m.Replica inside r.
function replicaNodes(list: readonly ReplicaDef[], doneCh: string, at: string): Record<string, NodeDef> {
  const nodes: Record<string, NodeDef> = {};
  list.forEach((r, i) => {
    // timer-1 belongs to replica-1, and so on: one name per node.
    nodes[r.timer] = timer({ label: `timer-${i + 1}`, pos: TIMER_POS[i]!, after: r.ms });
  });
  nodes.replica = goroutine({
    label: "replica",
    pos: POS.replica,
    count: list.length,
    base: 1,
    spawned: true,
    program: function* ({ i, vars }: Self) {
      const r = list[i]!;
      // timer := time.NewTimer(m.latency)
      yield start(r.timer, { at });
      const got: { i: number } = yield select([onRecv(r.timer), onRecv(doneCh)], { at });
      let value = "";
      if (got.i === 0) {
        vars.completed = (vars.completed ?? 0) + 1;
        value = r.v;
      } else {
        vars.cancelled = (vars.cancelled ?? 0) + 1;
        // defer timer.Stop(): the timer still runs, so this stops it.
        yield stop(r.timer, { at });
      }
      yield send("results", value);
    },
  });
  return nodes;
}

// main() with FetchFastest inlined: start every replica, take the first
// result, then main's own sleep. main's done is never closed.
function demo(doneCh: "nil" | "stop", cap: number, sleepMs: number, at: string): Pick<Model, "nodes"> {
  return {
    nodes: {
      ...replicaNodes(DEMO, doneCh, at),
      results: channel({ label: "results", pos: POS.results, cap }),
      caller: goroutine({
        label: "caller",
        pos: POS.caller,
        main: true,
        program: function* () {
          yield go("replica[*]");
          yield select([onRecv("results"), onRecv("done")]);
          // defer close(stop): FetchFastest closes it on the way out.
          if (doneCh === "stop") yield close("stop");
          yield sleep(sleepMs);
        },
      }),
      [doneCh]: channel({ label: doneCh, pos: POS.stop, cap: 0 }),
      done: channel({ label: "done", pos: POS.done, cap: 0 }),
    },
  };
}

const SCAFFOLD_CODE = `
@caller func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {
…
@caller 	results := make(chan replicaResult, len(replicas))
@caller
@caller 	for _, replica := range replicas {
@caller 		go func(r Replica) {
…
@replica 			value, err := r(nil)
@replica 			results <- replicaResult{value: value, err: err}
@caller 		}(replica)
@caller 	}
@caller
@caller 	select {
@caller 	case res := <-results:
@caller 		return res.value, res.err
@caller 	case <-done:
@caller 		return "", errors.New("fetchfastest: cancelled before any replica responded")
@caller 	}
@caller }
…
@caller 	time.Sleep(400 * time.Millisecond)`;

const solutionCode = (withMake: boolean, main: boolean): string =>
  [
    "@caller func FetchFastest(done <-chan struct{}, replicas ...Replica) (string, error) {",
    "…",
    "@caller 	stop := make(chan struct{})",
    "@caller 	defer close(stop)",
    "@caller",
    ...(withMake ? ["@caller 	results := make(chan replicaResult, len(replicas))", "@caller"] : ["…"]),
    "@caller 	for _, replica := range replicas {",
    "@caller 		go func(r Replica) {",
    "@replica 			value, err := r(stop)",
    "@replica 			results <- replicaResult{value: value, err: err}",
    "@caller 		}(replica)",
    "@caller 	}",
    "@caller",
    "@caller 	select {",
    "@caller 	case res := <-results:",
    "@caller 		return res.value, res.err",
    "@caller 	case <-done:",
    '@caller 		return "", errors.New("fetchfastest: cancelled before any replica responded")',
    "@caller 	}",
    "@caller }",
    ...(main ? ["…", "@caller 	time.Sleep(20 * time.Millisecond)"] : []),
  ].join("\n");

const cancelTests: Record<string, TestDef> = {
  closed: {
    name: "TestFetchFastestClosedDoneCancelsEarly",
    short: "done closed",
    // Both replicas observed done and neither ran to completion, and the
    // synctest bubble closed with no goroutine left blocked.
    judge: (run) => run.vars.cancelled === TEST.length && (run.vars.completed ?? 0) === 0 && run.outcome === "ok",
  },
};

// TestFetchFastestReturnsFastestValue asserts a property of any run of this
// shape: every loser observes its done closing and none runs to completion.
// Its own setup has four replicas, so the chip names the property, not the
// test's private numbers; main()'s run is judged on the same property.
const loserTests: Record<string, TestDef> = {
  losers: {
    name: "TestFetchFastestReturnsFastestValue",
    short: "losers stop",
    judge: (run) => run.vars.completed === 1 && run.vars.cancelled === DEMO.length - 1,
  },
};

const clock = { unit: "ms" } as const;

export default defineViz({
  schema: 3,
  exercise: "28-replicated-requests",
  // The Today fence draws r(nil); the Goal fence draws r(stop).
  diagrams: { today: "fnv1a:fa29664c", goal: "fnv1a:2d888749" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `Every replica gets a nil done. replica-B answers at ${K.bMs.value} ms. replica-A and replica-C still run until ${K.aMs.value} ms and ${K.cMs.value} ms.`,
      model: {
        ...demo("nil", DEMO.length, K.demoSleepMs.value, "r(nil)"),
        insight: `Each replica waits on its timer or done. Here done is nil, so it never fires. replica-B wins at ${K.bMs.value} ms. A and C keep waiting to ${K.aMs.value} ms and ${K.cMs.value} ms. Their answers land in results with no reader.`,
        stops: [
          {
            // replica-B's send hands its value to the waiting caller.
            when: { op: "send", g: "replica[1]" },
            say: `At ${K.bMs.value} ms replica-B answers first with B. The caller now has its value.`,
          },
          {
            when: { op: "fire", node: "timerA" },
            say: `At ${K.aMs.value} ms replica-A's timer still fires. No one wants A, but nil cannot stop it.`,
          },
          {
            when: { op: "fire", node: "timerC" },
            say: `At ${K.cMs.value} ms replica-C finishes too. No loser stopped early after replica-B won.`,
          },
        ],
        tests: loserTests,
        clock,
        code: { file: "main.go", text: SCAFFOLD_CODE },
        expect: { outcome: "ok", t: K.bMs.value + K.demoSleepMs.value, tests: { losers: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Every replica gets stop. replica-B answers at ${K.bMs.value} ms. stop closes at once, and replica-A and replica-C return early.`,
      model: {
        ...demo("stop", DEMO.length, K.demoSleepMs.value, "r(stop)"),
        insight: `Each replica now waits on its timer or stop. replica-B wins at ${K.bMs.value} ms. The caller closes stop as it returns. A and C wake at once, stop their timers, and return early.`,
        stops: [
          {
            when: { op: "close", node: "stop" },
            say: `replica-B wins at ${K.bMs.value} ms. The caller closes stop as it returns.`,
          },
          {
            when: { op: "stop", node: "timerC" },
            say: `replica-A and replica-C see that stop is closed. They stop their timers. Their ${K.aMs.value} ms and ${K.cMs.value} ms timers never fire.`,
          },
        ],
        tests: loserTests,
        clock,
        expect: { outcome: "ok", t: K.bMs.value + K.demoSleepMs.value, tests: { losers: "pass" } },
      },
    },
    {
      id: "winner",
      chip: "Winner",
      tier: "inside",
      summary: `replica-B wins. defer close(stop) wakes the losers. Their empty results fit in the ${DEMO.length} results slots.`,
      model: {
        ...demo("stop", DEMO.length, K.fixedSleepMs.value, "r(stop)"),
        insight: `defer close(stop) runs on every return path. The losers wake when B's value arrives. Each loser sends an empty result. results has one slot per replica, so no send blocks.`,
        stops: [
          {
            when: { op: "close", node: "stop" },
            say: "The caller has B. On the way out, defer close(stop) runs.",
          },
          {
            when: { op: "send", g: "replica[2]" },
            say: `The losers return an empty string and send it. The ${DEMO.length} results slots accept every send.`,
          },
        ],
        clock,
        code: { file: "solution", text: solutionCode(true, true) },
        expect: { outcome: "ok", t: K.bMs.value + K.fixedSleepMs.value },
      },
    },
    {
      id: "cancel",
      chip: "Cancel",
      tier: "inside",
      summary: "done is already closed. The select takes done at once. defer close(stop) still tells both replicas to stop.",
      model: {
        nodes: {
          ...replicaNodes(TEST, "stop", "r(stop)"),
          results: channel({ label: "results", pos: POS.results, cap: TEST.length }),
          caller: goroutine({
            label: "caller",
            pos: POS.caller,
            main: true,
            program: function* () {
              // The test closes done before it calls FetchFastest.
              yield close("done");
              yield go("replica[*]");
              yield select([onRecv("results"), onRecv("done")]);
              yield close("stop");
              // The test checks the replicas 5 ms later, then lets the
              // bubble drain.
              yield sleep(K.checkMs.value);
              yield sleep(K.drainMs.value);
            },
          }),
          stop: channel({ label: "stop", pos: POS.stop, cap: 0 }),
          done: channel({ label: "done", pos: POS.done, cap: 0 }),
        },
        insight: `done is already closed, so the select returns an error at once. defer close(stop) runs on this path too. Replicas a and b see stop and stop their timers. Their ${K.testAMs.value} ms and ${K.testBMs.value} ms timers never fire.`,
        stops: [
          {
            when: { op: "close", node: "stop" },
            say: "The select takes done at once. On the way out, defer close(stop) still runs.",
          },
          {
            // b runs after a, so its return is the last one.
            when: { op: "return", g: "replica[1]" },
            say: `a and b see stop, stop their timers, and return. At ${K.checkMs.value} ms the test checks them.`,
          },
        ],
        tests: cancelTests,
        clock,
        code: { file: "solution", text: solutionCode(true, false) },
        expect: { outcome: "ok", t: K.checkMs.value + K.drainMs.value, tests: { closed: "pass" } },
      },
    },
    {
      id: "leak",
      chip: "Leak",
      tier: "inside",
      summary: "This is the same fix with an unbuffered results. replica-B's value reaches the caller. The losers' empty sends have no receiver and block.",
      model: {
        ...demo("stop", 0, K.fixedSleepMs.value, "r(stop)"),
        insight:
          "Closing stop is only half the fix. The losers wake and return. They then send on results. Without a buffer, each send needs a receiver. The caller is gone, so A and C block forever. This replaces a timer leak with a send leak.",
        stops: [
          {
            when: { op: "close", node: "stop" },
            say: "replica-B hands B to the caller. The caller closes stop and leaves.",
          },
          {
            when: { op: "block", g: "replica[2]" },
            say: "replica-A and replica-C wake and send on results. No receiver will come, so they block.",
          },
        ],
        clock,
        code: { file: "solution", text: solutionCode(false, true) },
        expect: { outcome: "leak", t: K.bMs.value + K.fixedSleepMs.value },
      },
    },
  ],
});
