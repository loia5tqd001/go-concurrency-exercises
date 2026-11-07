// 13 is a fan-in over a channel of channels. LogHub hands each shard's lines
// channel over on chanStream, one every 5 ms, while every shard already
// produces a line every 10 ms. The scaffold's Bridge takes one shard off
// chanStream and never goes back, so LogHub and shard 1 block forever and
// main gets 4 of the 20 lines. The Goal reads chanStream until it closes,
// starts one fwd per shard, and closes out only after every fwd finishes.
//
// The Problem scenes model main(), which makes the same StartLogHub(5, 4)
// call as TestBridgeFlattensAllShards. done is never closed during that run,
// so the scenes leave it out: a select on it waits on its other case only.

import {
  add,
  channel,
  close,
  defineViz,
  done,
  go,
  goroutine,
  onRecv,
  onSend,
  print,
  range,
  recv,
  select,
  send,
  sleep,
  wait,
  waitgroup,
} from "../engine/ops.ts";
import type { Model, NodeDef, Pos } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  shards: { value: 5, file: "main.go", text: "shardStream := StartLogHub(5, 4)" },
  lines: { value: 4, file: "main.go", text: "shardStream := StartLogHub(5, 4)" },
  shardMs: { value: 5, file: "mockloghub.go", text: "time.Sleep(5 * time.Millisecond)" },
  lineMs: { value: 10, file: "mockloghub.go", text: "time.Sleep(10 * time.Millisecond)" },
} as const;

const SHARDS = K.shards.value;
const LINES = K.lines.value;
const TOTAL = SHARDS * LINES;
// Shard 0 sends its last line at 4 x 10 ms; shard 4 starts at 4 x 5 ms.
const END_TODAY = LINES * K.lineMs.value;
const END_GOAL = (SHARDS - 1) * K.shardMs.value + LINES * K.lineMs.value;

// A line is "shard-line": the mock's "shard-%d-line-%d" in 3 characters.
const line = (shard: number, k: number): string => `${shard}-${k}`;
const linesOf = (shard: number): string => `lines${shard}`;

type Layout = Record<string, Pos>;

// Both scenes stay within two rows, so a phone keeps two wide lanes for
// "chanStream <-". In the Goal the lines channels form a strip above the
// shards and the forwarders, and the lines flow left to right along the
// bottom row: shard, strip, fwd, out, main.
const TODAY: Layout = {
  LogHub: [0, 0],
  chanStream: [1, 0],
  Bridge: [2, 0],
  out: [3, 0],
  main: [4, 1],
  lines1: [0, 0.9],
  shard: [1, 1],
  lines0: [2, 0.9],
};
const GOAL: Layout = {
  lines0: [0, 0],
  lines1: [0.55, 0],
  lines2: [1.1, 0],
  lines3: [1.65, 0],
  lines4: [2.2, 0],
  shard: [0, 1.16],
  fwd: [1, 1.16],
  out: [2, 1.16],
  main: [3, 1.16],
  LogHub: [4, 1.16],
  chanStream: [4, 0],
  Bridge: [3, 0],
  wg: [3.5, 0.58],
};

// The goroutines and channels both Problem scenes share.
function hub(at: Layout, shardCount: number): Record<string, NodeDef> {
  const nodes: Record<string, NodeDef> = {
    // StartLogHub's goroutine: start a shard, hand its lines channel over,
    // wait 5 ms, repeat; close chanStream after the last one.
    LogHub: goroutine({
      label: "LogHub",
      pos: at.LogHub!,
      spawned: true,
      program: function* () {
        for (let i = 0; i < SHARDS; i++) {
          yield go(`shard[${i}]`);
          yield send("chanStream", `s${i}`);
          yield sleep(K.shardMs.value);
        }
        yield close("chanStream");
      },
    }),
    // One producer per shard: a line every 10 ms, then close its channel.
    shard: goroutine({
      label: "shard",
      pos: at.shard!,
      count: SHARDS,
      spawned: true,
      program: function* ({ i }) {
        for (let k = 0; k < LINES; k++) {
          yield sleep(K.lineMs.value);
          yield send(linesOf(i), line(i, k));
        }
        yield close(linesOf(i));
      },
    }),
    chanStream: channel({ label: "chanStream", pos: at.chanStream!, cap: 0 }),
    out: channel({ label: "out", pos: at.out!, cap: 0 }),
    // main(): start the hub and Bridge, print every line, then the count.
    main: goroutine({
      label: "main",
      pos: at.main!,
      main: true,
      program: function* () {
        yield go("LogHub", { at: "shardStream := StartLogHub(5, 4)" });
        yield go("Bridge", { at: "logs := Bridge(shardStream, done)" });
        let count = 0;
        yield* range(
          "out",
          function* (r) {
            yield print(r.tok!, { at: "fmt.Println(line)" });
            count++;
          },
          { at: "for line := range logs {" },
        );
        yield print(count, { at: 'fmt.Println("Total log lines:", count)' });
      },
    }),
  };
  // Only the channels LogHub gets to make exist in the run.
  for (let i = 0; i < shardCount; i++) {
    nodes[linesOf(i)] = channel({ label: `lines-${i}`, pos: at[linesOf(i)]!, cap: 0 });
  }
  return nodes;
}

const today: Model = {
  nodes: {
    // LogHub blocks handing over shard 1, so it never makes a third channel.
    ...hub(TODAY, 2),
    Bridge: goroutine({
      label: "Bridge",
      pos: TODAY.Bridge!,
      spawned: true,
      program: function* () {
        const first = yield recv("chanStream", { at: "stream, ok := <-chanStream" });
        const stream = linesOf(Number(String(first.v).slice(1)));
        // Both selects also wait on done, which never closes in main().
        for (;;) {
          const r = yield select([onRecv(stream)], { at: "case v, ok := <-stream:" });
          if (!r.ok) break;
          yield select([onSend("out", r.tok!)], { at: "case valStream <- v:" });
        }
        yield close("out", { at: "defer close(valStream)" });
      },
    }),
  },
  insight: `Bridge takes one shard off chanStream and never reads it again. LogHub waits forever to hand over shard 1, and shard 1 waits forever on its first line, so main prints ${LINES} of ${TOTAL} lines.`,
  stops: [
    {
      when: { op: "block", g: "LogHub" },
      say: `At ${K.shardMs.value} ms LogHub tries to hand over shard 1, but Bridge never reads chanStream again.`,
    },
    {
      when: { op: "close", node: "out" },
      say: `shard 0 closes its lines at ${END_TODAY} ms, so Bridge closes out. The other ${TOTAL - LINES} lines never arrive.`,
    },
  ],
  // LogHub runs mock code, so it owns only the line that starts it; its
  // operations then mark no line instead of another goroutine's.
  code: {
    file: "main.go",
    text: `
@Bridge 	go func() {
@Bridge 		defer close(valStream)
@Bridge
@Bridge 		stream, ok := <-chanStream
@Bridge 		if !ok {
@Bridge 			return
@Bridge 		}
@Bridge
@Bridge 		for {
@Bridge 			select {
@Bridge 			case <-done:
@Bridge 				return
@Bridge 			case v, ok := <-stream:
@Bridge 				if !ok {
@Bridge 					return
@Bridge 				}
@Bridge 				select {
@Bridge 				case valStream <- v:
@Bridge 				case <-done:
@Bridge 					return
@Bridge 				}
@Bridge 			}
@Bridge 		}
@Bridge 	}()
…
@main,LogHub 	shardStream := StartLogHub(5, 4)
@main 	logs := Bridge(shardStream, done)
@main
@main 	count := 0
@main 	for line := range logs {
@main 		fmt.Println(line)
@main 		count++
@main 	}
@main
@main 	fmt.Println("Total log lines:", count)`,
  },
  clock: { unit: "ms" },
  expect: { outcome: "leak", t: END_TODAY },
};

const goal: Model = {
  nodes: {
    ...hub(GOAL, SHARDS),
    Bridge: goroutine({
      label: "Bridge",
      pos: GOAL.Bridge!,
      spawned: true,
      program: function* () {
        // select { case stream, ok := <-chanStream: ... case <-done: ... }
        // with done never closed: only the chanStream case can run.
        for (;;) {
          const r = yield select([onRecv("chanStream")]);
          if (!r.ok) break;
          yield add("wg", 1);
          yield go(`fwd[${String(r.v).slice(1)}]`);
        }
        yield wait("wg");
        yield close("out");
      },
    }),
    // The README's "out closes once ... all 5 forwarders finish": a counter
    // of the fwds still running.
    wg: waitgroup({ label: "forwarders", pos: GOAL.wg! }),
    fwd: goroutine({
      label: "fwd",
      pos: GOAL.fwd!,
      count: SHARDS,
      spawned: true,
      program: function* ({ i }) {
        // Each receive and send selects with done too; done never closes.
        for (;;) {
          const r = yield select([onRecv(linesOf(i))]);
          if (!r.ok) break;
          yield select([onSend("out", r.tok!)]);
        }
        yield done("wg");
      },
    }),
  },
  insight: `Bridge keeps reading chanStream and starts one fwd per shard, so all five shards drain at once. out closes only after chanStream has closed and every fwd has finished: main prints all ${TOTAL} lines.`,
  stops: [
    {
      when: { op: "go", g: "Bridge", nth: SHARDS },
      say: `By ${(SHARDS - 1) * K.shardMs.value} ms Bridge has started a fwd for each shard. From here on the lines of all five interleave on out.`,
    },
    {
      when: { op: "close", node: "out" },
      say: `The last shard closes at ${END_GOAL} ms and its fwd finishes. Only now does Bridge close out.`,
    },
  ],
  clock: { unit: "ms" },
  expect: { outcome: "ok", t: END_GOAL },
};

export default defineViz({
  schema: 3,
  exercise: "13-channel-of-channels",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:62d21793", goal: "fnv1a:62d21793" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The naive Bridge reads only shard 0, so main prints ${LINES} of ${TOTAL} lines while LogHub and shard 1 block forever.`,
      model: today,
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Bridge starts one fwd per shard as it arrives; all ${TOTAL} lines reach main, and out closes once every fwd finishes.`,
      model: goal,
    },
  ],
});

