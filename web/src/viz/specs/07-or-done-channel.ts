// 07 is about a goroutine that must notice `done` at every point where it can
// block. The scaffold returns `c` unchanged, so out IS c: closing done reaches
// nobody, and out never closes. A forwarder goroutine selects on done while it
// waits on c and again while it waits to send on out, so done unblocks it
// wherever it is parked, and `defer close(out)` tells the reader.
//
// The run is TestOrDoneStopsPromptlyMidForward: a feed writes 1, 2, 3, … on c
// until done closes, the test reads one value, sleeps 20 ms, closes done, then
// reads out once more with a 100 ms real-time safety net. TestOrDoneForwardsValues
// passes on the scaffold; the other tests are the same shutdown repeated, or
// with a c nobody writes to (the inside scene).
//
// Not drawn: the order of the test's own deferred calls, and StartMetricStream
// (the test's feed stands in for it).

import {
  channel,
  close,
  defineViz,
  fail,
  goroutine,
  onRecv,
  onSend,
  pass,
  recv,
  select,
  send,
  sleep,
  start,
  timer,
  go,
} from "../engine/ops.ts";
import type { Op, SelectResult } from "../engine/model.ts";

// What the engine sends back into a program: a RecvResult, a SelectResult, or
// nothing. `Program` in model.ts declares the same `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, void, any>;

// Every number names its source in the committed exercise.
const K = {
  netMs: { value: 100, file: "check_test.go", text: "case <-time.After(100 * time.Millisecond):" },
  sleepMs: { value: 20, file: "check_test.go", text: "time.Sleep(20 * time.Millisecond)" },
} as const;

const midTests = {
  stops: { name: "TestOrDoneStopsPromptlyMidForward", short: "out closes" },
};

const idleTests = {
  idle: { name: "TestOrDoneStopsPromptlyOnDone", short: "out closes" },
};

// The test's feed: v++, then select { c <- v ; <-done }, until done.
function* feed(): Gen {
  let v = 0;
  for (;;) {
    v++;
    const s: SelectResult = yield select([onSend("c", v), onRecv("done")]);
    if (s.i === 1) return;
  }
}

// The test's last step: read out once, racing the 100 ms safety net.
// A value, or the net firing, fails the test; a closed channel passes it.
function* lastRead(test: string, from: string): Gen {
  yield start("net");
  const s: SelectResult = yield select([onRecv(from), onRecv("net")]);
  yield s.i === 0 && !s.ok ? pass(test) : fail(test);
}

// time.After(100ms) in the test's last read.
const net = (pos: readonly [number, number]) => timer({ label: "time.After", pos, after: K.netMs.value });

export default defineViz({
  schema: 3,
  exercise: "07-or-done-channel",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:cfed0d46", goal: "fnv1a:cfed0d46" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `orDone returns c, so out is c: closing done reaches nobody, and out never closes. The test waits ${K.netMs.value} ms for it and fails.`,
      model: {
        nodes: {
          feed: goroutine({ label: "feed", pos: [0, 1], spawned: true, program: feed }),
          c: channel({ label: "c", pos: [1, 1], cap: 0 }),
          done: channel({ label: "done", pos: [1, 0], cap: 0 }),
          main: goroutine({
            label: "main",
            pos: [2, 1],
            main: true,
            program: function* (): Gen {
              yield go("feed");
              yield recv("c");
              yield sleep(K.sleepMs.value);
              yield close("done");
              yield* lastRead("stops", "c");
            },
          }),
          net: net([2, 0]),
        },
        insight: `out IS c, so closing done changes nothing the reader can see. The feed stops on its own when done closes, but nobody closes c, so the last read waits the full ${K.netMs.value} ms and the test fails.`,
        stops: [
          { when: { op: "close", node: "done" }, say: "done closes. orDone has no goroutine, so nothing here reacts to it." },
          { when: { op: "fire", node: "net" }, say: `${K.netMs.value} ms pass and out is still open. The test fails.` },
        ],
        tests: midTests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@main func orDone(done <-chan struct{}, c <-chan int) <-chan int {
@main 	return c
@main }`,
        },
        expect: { outcome: "ok", t: K.sleepMs.value + K.netMs.value, tests: { stops: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `A forwarder goroutine selects on c or done, and on out or done. Closing done unblocks it wherever it waits, and it closes out.`,
      model: {
        nodes: {
          feed: goroutine({ label: "feed", pos: [0, 1], spawned: true, program: feed }),
          c: channel({ label: "c", pos: [1, 1], cap: 0 }),
          forwarder: goroutine({
            label: "forwarder",
            pos: [2, 1],
            spawned: true,
            program: function* (): Gen {
              for (;;) {
                const got: SelectResult = yield select([onRecv("done"), onRecv("c")]);
                if (got.i === 0 || !got.ok) break;
                const s: SelectResult = yield select([onSend("out", got.v), onRecv("done")]);
                if (s.i === 1) break;
              }
              yield close("out");
            },
          }),
          out: channel({ label: "out", pos: [3, 1], cap: 0 }),
          done: channel({ label: "done", pos: [2, 0], cap: 0 }),
          main: goroutine({
            label: "main",
            pos: [4, 1],
            main: true,
            program: function* (): Gen {
              yield go("feed");
              yield go("forwarder");
              yield recv("out");
              yield sleep(K.sleepMs.value);
              yield close("done");
              yield* lastRead("stops", "out");
            },
          }),
          net: net([4, 0]),
        },
        insight: `While done is open the forwarder carries each value from c to out. When done closes it is parked in the send select, so that case fires, it returns, and out closes. The last read sees a closed out at once.`,
        stops: [
          { when: { op: "block", g: "forwarder", nth: 1 }, say: "Nobody is reading out, so the forwarder waits to send the value it holds. This select also watches done." },
          { when: { op: "close", node: "done" }, say: "done closes: the parked select fires, the forwarder returns, and out closes behind it." },
        ],
        tests: midTests,
        clock: { unit: "ms" },
        expect: { outcome: "ok", tests: { stops: "pass" } },
      },
    },
    {
      id: "oneselect",
      chip: "1 select",
      tier: "inside",
      summary: `A forwarder that ranges over c and selects only on the send never sees done while it waits on c, so out never closes and the test fails.`,
      model: {
        nodes: {
          c: channel({ label: "c", pos: [0, 1], cap: 0 }),
          forwarder: goroutine({
            label: "forwarder",
            pos: [1, 1],
            spawned: true,
            program: function* (): Gen {
              for (;;) {
                const r: { ok: boolean; v: number } = yield recv("c", { at: "for v := range c" });
                if (!r.ok) break;
                const s: SelectResult = yield select([onSend("out", r.v), onRecv("done")], { at: "case out <- v:" });
                if (s.i === 1) return;
              }
            },
          }),
          out: channel({ label: "out", pos: [2, 1], cap: 0 }),
          done: channel({ label: "done", pos: [1, 0], cap: 0 }),
          reader: goroutine({
            label: "reader",
            pos: [3, 1],
            spawned: true,
            program: function* (): Gen {
              const r: { ok: boolean } = yield recv("out");
              yield send("result", r.ok);
            },
          }),
          result: channel({ label: "result", pos: [3, 0], cap: 1 }),
          main: goroutine({
            label: "main",
            pos: [4, 1],
            main: true,
            program: function* (): Gen {
              yield go("forwarder");
              yield go("reader");
              yield close("done");
              yield start("net");
              const s: SelectResult = yield select([onRecv("result"), onRecv("net")]);
              yield s.i === 0 && !s.v ? pass("idle") : fail("idle");
            },
          }),
          net: net([3, 2]),
        },
        insight: `In this test c is never written to. The forwarder is parked in range c, which does not watch done, so closing done cannot reach it. out stays open, the reader hangs, and the test fails. This leak is the learner's bug: every blocking point needs its own select.`,
        stops: [
          { when: { op: "close", node: "done" }, say: "done closes, but the forwarder is waiting on c, and that receive has no done case." },
          { when: { op: "fire", node: "net" }, say: `${K.netMs.value} ms pass and out is still open. The test fails.` },
        ],
        tests: idleTests,
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@forwarder // BROKEN: only the send is done-aware
@forwarder for v := range c {
@forwarder 	select {
@forwarder 	case out <- v:
@forwarder 	case <-done:
@forwarder 		return
@forwarder 	}
@forwarder }`,
        },
        expect: { outcome: "leak", t: K.netMs.value, tests: { idle: "fail" } },
      },
    },
  ],
});
