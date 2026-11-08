// Unit tests of the scheduler's Go rules, the timeline, and the layout.
// A spec relies on these rules; if one breaks, every scene that uses it lies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diagramHash, normalizeDiagram } from "../src/viz/engine/diagramHash.ts";
import { layout } from "../src/viz/engine/layout.ts";
import type { Model, NodeDef, RecvResult, SelectResult } from "../src/viz/engine/model.ts";
import {
  add,
  append,
  channel,
  close,
  cond,
  condBroadcast,
  condSignal,
  condWait,
  context,
  done,
  exit,
  go,
  goroutine,
  lock,
  mutex,
  notify,
  onRecv,
  onSend,
  print,
  put,
  range,
  recv,
  remake,
  reset,
  select,
  send,
  shift,
  sleep,
  slice,
  start,
  timer,
  unlock,
  wait,
  waitgroup,
  work,
} from "../src/viz/engine/ops.ts";
import { runModel } from "../src/viz/engine/sim.ts";
import { buildTimeline, frameAt, nextStop, prevStop } from "../src/viz/engine/timeline.ts";

function model(nodes: Record<string, NodeDef>, extra: Partial<Model> = {}): Model {
  return { nodes, insight: "", expect: { outcome: "ok" }, ...extra };
}

let col = 0;
const at = (): [number, number] => [col++, 0];

// ---------------------------------------------------------------------------
// diagramHash (shared fixture with tools/check/diagram_test.go)
// ---------------------------------------------------------------------------

test("diagramHash normalizes CRLF, trailing whitespace, and blank edges", () => {
  const raw = "+-------+\r\n|  ch   |   \n+-------+\n\n";
  assert.equal(normalizeDiagram(raw), "+-------+\n|  ch   |\n+-------+");
  assert.equal(diagramHash(raw), "fnv1a:43d3b52c");
});

test("diagramHash uses FNV-1a over UTF-8 bytes", () => {
  assert.equal(diagramHash(""), "fnv1a:811c9dc5");
  assert.equal(diagramHash("  \n\n"), "fnv1a:811c9dc5");
  assert.equal(diagramHash("→"), "fnv1a:9f874291");
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

test("an unbuffered send waits for a receiver, then hands the value straight over", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 0 }),
      tx: goroutine({ label: "tx", pos: at(), program: function* () { yield send("ch", 7); } }),
      rx: goroutine({
        label: "rx",
        pos: at(),
        main: true,
        program: function* () {
          yield sleep(10);
          const r: RecvResult = yield recv("ch");
          assert.equal(r.v, 7);
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  const parked = run.steps.find((s) => s.event.g === "tx" && s.event.parked === true);
  assert.ok(parked, "tx parks on the send");
  assert.equal(parked.world.g.tx!.why, "ch <-");
  const handoff = run.steps.find((s) => s.event.g === "rx" && s.event.op === "recv");
  assert.ok(handoff?.moves.some((m) => m.via === "ch" && m.from.node === "tx" && m.to.node === "rx"));
});

test("a send to a parked receiver hands off and never touches the buffer", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 2 }),
      rx: goroutine({ label: "rx", pos: at(), main: true, program: function* () { yield recv("ch"); } }),
      tx: goroutine({ label: "tx", pos: at(), program: function* () { yield sleep(5); yield send("ch", 1); } }),
    }),
  );
  const step = run.steps.find((s) => s.event.op === "send")!;
  assert.deepEqual(step.world.ch.ch!.buf, []);
  assert.equal(step.moves[0]!.via, "ch");
  assert.equal(step.moves[0]!.to.node, "rx");
});

test("a full buffer parks the sender; a receive pulls its value into the freed slot", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 1 }),
      tx: goroutine({
        label: "tx",
        pos: at(),
        program: function* () {
          yield send("ch", 1);
          yield send("ch", 2);
        },
      }),
      rx: goroutine({
        label: "rx",
        pos: at(),
        main: true,
        program: function* () {
          yield sleep(10);
          const r: RecvResult = yield recv("ch");
          assert.equal(r.v, 1);
          yield sleep(10);
          const s: RecvResult = yield recv("ch");
          assert.equal(s.v, 2);
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  const take = run.steps.find((s) => s.event.op === "recv" && s.event.v === 1)!;
  const tok2 = Object.entries(take.world.tokens).find(([, t]) => t.v === 2)!;
  assert.deepEqual(tok2[1].at, { node: "ch", slot: 0 });
  assert.equal(take.world.g.tx!.status, "running");
});

test("close wakes every receiver with ok = false, and range ends", () => {
  const got: number[] = [];
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 3 }),
      tx: goroutine({
        label: "tx",
        pos: at(),
        program: function* () {
          yield send("ch", 1);
          yield send("ch", 2);
          yield close("ch");
        },
      }),
      rx: goroutine({
        label: "rx",
        pos: at(),
        main: true,
        program: function* () {
          yield* range("ch", function* (r) {
            got.push(Number(r.v));
            yield print(r.tok!);
          });
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  assert.deepEqual(got, [1, 2]);
  assert.equal(run.world.printed.length, 2);
});

test("a send on a closed channel panics", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 1 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield close("ch");
          yield send("ch", 1);
        },
      }),
    }),
  );
  assert.equal(run.outcome, "panic");
  assert.match(run.verdict, /send on closed channel ch/);
});

test("notify drops a value when the buffer is full", () => {
  const run = runModel(
    model({
      sig: channel({ label: "sig", pos: at(), cap: 1 }),
      os: goroutine({
        label: "os",
        pos: at(),
        main: true,
        program: function* () {
          yield notify("sig", "^C");
          yield notify("sig", "^C");
        },
      }),
    }),
  );
  assert.equal(run.world.ch.sig!.buf.length, 1);
  assert.match(run.steps[1]!.event.text, /dropped/);
});

// ---------------------------------------------------------------------------
// Ends: leak, deadlock, timeout
// ---------------------------------------------------------------------------

test("main returning while another goroutine is blocked is a leak", () => {
  const run = runModel(
    model({
      out: channel({ label: "out", pos: at(), cap: 0 }),
      gen: goroutine({ label: "gen", pos: at(), program: function* () { for (;;) yield send("out", 1); } }),
      main: goroutine({ label: "main", pos: at(), main: true, program: function* () { yield recv("out"); } }),
    }),
  );
  assert.equal(run.outcome, "leak");
  assert.equal(run.world.g.gen!.status, "leaked");
  assert.match(run.verdict, /^The program leaked a goroutine\. gen is blocked on out <-/);
});

test("main blocked with nothing left to wake it is a deadlock", () => {
  const run = runModel(
    model({
      a: mutex({ label: "A", pos: at() }),
      b: mutex({ label: "B", pos: at() }),
      p: goroutine({
        label: "p",
        pos: at(),
        main: true,
        program: function* () {
          yield lock("a");
          yield sleep(1);
          yield lock("b");
        },
      }),
      q: goroutine({
        label: "q",
        pos: at(),
        program: function* () {
          yield lock("b");
          yield sleep(1);
          yield lock("a");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "deadlock");
  assert.equal(run.world.g.p!.status, "deadlocked");
  // Two goroutines each hold the lock the other wants.
  assert.match(run.verdict, /^Deadlock\. (p waits for q, q waits for p|q waits for p, p waits for q)\./);
});

test("endless work stops at until and reads as a timeout", () => {
  const run = runModel(
    model(
      { g: goroutine({ label: "g", pos: at(), main: true, program: function* () { yield work(Infinity, "Stop()"); } }) },
      { until: 500 },
    ),
  );
  assert.equal(run.outcome, "timeout");
  assert.equal(run.t, 500);
});

// ---------------------------------------------------------------------------
// select, sync, timers, contexts
// ---------------------------------------------------------------------------

test("select picks among ready cases with the seed, and the same seed repeats", () => {
  const pick = (seed: number): number => {
    let chosen = -1;
    runModel(
      model({
        a: channel({ label: "a", pos: at(), cap: 1 }),
        b: channel({ label: "b", pos: at(), cap: 1 }),
        g: goroutine({
          label: "g",
          pos: at(),
          main: true,
          program: function* () {
            yield send("a", 1);
            yield send("b", 2);
            const r: SelectResult = yield select([onRecv("a"), onRecv("b")]);
            chosen = r.i;
          },
        }),
      }),
      { seed },
    );
    return chosen;
  };
  const seen = new Set<number>();
  for (let seed = 1; seed <= 20; seed++) seen.add(pick(seed));
  assert.deepEqual([...seen].sort(), [0, 1]);
  assert.equal(pick(7), pick(7));
});

test("a parked select wakes through the case that becomes ready", () => {
  let won = -1;
  runModel(
    model({
      a: channel({ label: "a", pos: at(), cap: 0 }),
      b: channel({ label: "b", pos: at(), cap: 0 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          const r: SelectResult = yield select([onRecv("a"), onSend("b", 5)]);
          won = r.i;
        },
      }),
      h: goroutine({ label: "h", pos: at(), program: function* () { yield sleep(3); yield recv("b"); } }),
    }),
  );
  assert.equal(won, 1);
});

test("a wait group wakes its waiter at zero and panics below zero", () => {
  const ok = runModel(
    model({
      wg: waitgroup({ label: "wg", pos: at() }),
      w: goroutine({ label: "w", pos: at(), count: 3, spawned: true, program: function* () { yield work(10); yield done("wg"); } }),
      m: goroutine({
        label: "m",
        pos: at(),
        main: true,
        program: function* () {
          yield add("wg", 3);
          yield go("w[*]");
          yield wait("wg");
        },
      }),
    }),
  );
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.t, 10);
  const bad = runModel(model({ wg: waitgroup({ label: "wg", pos: at() }), m: goroutine({ label: "m", pos: at(), main: true, program: function* () { yield done("wg"); } }) }));
  assert.equal(bad.outcome, "panic");
});

test("a mutex has one holder, and its key token travels to the holder", () => {
  const run = runModel(
    model({
      mu: mutex({ label: "mu", pos: at() }),
      a: goroutine({ label: "a", pos: at(), main: true, program: function* () { yield lock("mu"); yield work(5); yield unlock("mu"); } }),
      b: goroutine({ label: "b", pos: at(), program: function* () { yield lock("mu"); yield unlock("mu"); } }),
    }),
  );
  assert.equal(run.outcome, "ok");
  const waiting = run.steps.find((s) => s.event.g === "b" && s.event.parked === true)!;
  assert.equal(waiting.world.mu.mu!.holder, "a");
  const key = waiting.world.mu.mu!.key;
  assert.equal(waiting.world.tokens[key]!.at.node, "a");
});

test("a cond wait releases its mutex and reacquires it after Signal", () => {
  const run = runModel(
    model({
      wg: waitgroup({ label: "wg", pos: at() }),
      mu: mutex({ label: "mu", pos: at() }),
      ready: cond({ label: "ready", pos: at(), mu: "mu" }),
      waiter: goroutine({
        label: "waiter",
        pos: at(),
        spawned: true,
        program: function* () {
          yield lock("mu");
          yield condWait("ready");
          yield unlock("mu");
          yield done("wg");
        },
      }),
      signaler: goroutine({
        label: "signaler",
        pos: at(),
        spawned: true,
        program: function* () {
          yield sleep(5);
          yield lock("mu");
          yield condSignal("ready");
          yield unlock("mu");
        },
      }),
      main: goroutine({
        label: "main",
        pos: at(),
        main: true,
        program: function* () {
          yield lock("mu");
          yield add("wg", 1);
          yield go("waiter");
          yield go("signaler");
          yield unlock("mu");
          yield wait("wg");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  const waitingIndex = run.steps.findIndex((step) => step.event.op === "condWait");
  const waiting = run.steps[waitingIndex]!;
  assert.equal(waiting.world.cond.ready!.waiters, 1);
  assert.equal(waiting.world.mu.mu!.holder, undefined);
  assert.equal(
    run.steps.slice(0, waitingIndex).some((step) => step.event.g === "waiter" && step.event.op === "unlock"),
    false,
    "Wait releases the mutex atomically rather than recording a separate Unlock",
  );
  const signaling = run.steps.find((step) => step.event.op === "condSignal")!;
  assert.equal(signaling.world.cond.ready!.waiters, 0);
  assert.equal(signaling.world.g.waiter!.status, "blocked");
  assert.match(signaling.world.g.waiter!.why!, /mu\.Lock\(\)/);
});

test("a cond Broadcast wakes every waiter and each reacquires the mutex", () => {
  const run = runModel(
    model({
      wg: waitgroup({ label: "wg", pos: at() }),
      mu: mutex({ label: "mu", pos: at() }),
      ready: cond({ label: "ready", pos: at(), mu: "mu" }),
      waiter: goroutine({
        label: "waiter",
        pos: at(),
        count: 2,
        spawned: true,
        program: function* () {
          yield lock("mu");
          yield condWait("ready");
          yield unlock("mu");
          yield done("wg");
        },
      }),
      signaler: goroutine({
        label: "signaler",
        pos: at(),
        spawned: true,
        program: function* () {
          yield sleep(5);
          yield lock("mu");
          yield condBroadcast("ready");
          yield unlock("mu");
        },
      }),
      main: goroutine({
        label: "main",
        pos: at(),
        main: true,
        program: function* () {
          yield lock("mu");
          yield add("wg", 2);
          yield go("waiter[*]");
          yield go("signaler");
          yield unlock("mu");
          yield wait("wg");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  const broadcast = run.steps.find((step) => step.event.op === "condBroadcast")!;
  assert.equal(broadcast.world.cond.ready!.waiters, 0);
  assert.equal(
    Object.entries(broadcast.world.g).filter(([key, g]) => key.startsWith("waiter[") && g.status === "blocked").length,
    2,
  );
});

test("a cond Wait without its associated mutex panics", () => {
  const run = runModel(
    model({
      mu: mutex({ label: "mu", pos: at() }),
      ready: cond({ label: "ready", pos: at(), mu: "mu" }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield condWait("ready");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "panic");
  assert.match(run.verdict, /Wait called without holding mu/);
});

test("a slice shift removes and returns its head", () => {
  let first = -1;
  let second = -1;
  const run = runModel(
    model({
      q: slice({ label: "q", pos: at(), size: 3 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield append("q", 1);
          yield append("q", 2);
          const a: RecvResult = yield shift("q");
          first = Number(a.v);
          const b: RecvResult = yield shift("q");
          second = Number(b.v);
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.deepEqual(run.world.slice.q, [null, null, null]);
  const firstShift = run.steps.find((step) => step.event.op === "shift")!;
  const remaining = firstShift.world.slice.q.find((token) => token !== null)!;
  assert.equal(firstShift.world.tokens[remaining]!.at.slot, 0);
});

test("a timer fires after its delay, and reset discards an unread tick", () => {
  const run = runModel(
    model({
      t: timer({ label: "t", pos: at(), after: 100 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield start("t");
          yield sleep(150);
          yield reset("t");
          yield recv("t");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  assert.equal(run.t, 250);
});

test("a context deadline closes Done and wakes its waiter", () => {
  const run = runModel(
    model({
      ctx: context({ label: "ctx", pos: at(), deadline: 100 }),
      g: goroutine({ label: "g", pos: at(), main: true, program: function* () { yield recv("ctx"); } }),
    }),
  );
  assert.equal(run.outcome, "ok");
  assert.equal(run.t, 100);
  assert.equal(run.world.ctx.ctx!.cause, "deadline");
});

test("a forwarded token keeps its identity; a token one does not hold cannot be sent", () => {
  const bad = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 1 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield send("ch", 1);
          const r: RecvResult = yield recv("ch");
          yield send("ch", r.tok!);
          yield send("ch", r.tok!);
        },
      }),
    }),
  );
  assert.equal(bad.outcome, "panic");
  assert.ok(bad.errors.some((e) => /does not hold/.test(e)));
});

// ---------------------------------------------------------------------------
// Timeline and layout
// ---------------------------------------------------------------------------

test("the clock stands still during a batch, and independent moves share one batch", () => {
  const run = runModel(
    model({
      s: slice({ label: "s", pos: at(), size: 4 }),
      w: goroutine({ label: "w", pos: at(), count: 4, main: false, program: function* ({ i }) { yield work(10); yield put("s", i, i); } }),
      m: goroutine({ label: "m", pos: at(), main: true, program: function* () { yield sleep(20); } }),
    }),
  );
  const tl = buildTimeline(run, 2);
  const at10 = tl.beats.filter((b) => b.kind === "batch" && b.t0 === 10);
  assert.equal(at10.length, 1, "four puts at one instant play together");
  assert.equal(at10[0]!.moves.length, 4);
  const time = tl.beats.find((b) => b.kind === "time")!;
  assert.equal(time.d, (time.t1 - time.t0) * 2);
  const mid = frameAt(tl, at10[0]!.start + at10[0]!.d / 2)!;
  assert.equal(mid.t, 10);
  assert.ok(nextStop(tl, 0) > 0);
  assert.equal(prevStop(tl, nextStop(tl, 0)), 0);
});

test("a chain at one instant plays in order: a value never moves twice in a batch", () => {
  const run = runModel(
    model({
      a: channel({ label: "a", pos: at(), cap: 0 }),
      b: channel({ label: "b", pos: at(), cap: 0 }),
      src: goroutine({ label: "src", pos: at(), program: function* () { yield send("a", 1); } }),
      fwd: goroutine({ label: "fwd", pos: at(), program: function* () { const r: RecvResult = yield recv("a"); yield send("b", r.tok!); } }),
      dst: goroutine({ label: "dst", pos: at(), main: true, program: function* () { yield recv("b"); } }),
    }),
  );
  const tl = buildTimeline(run, 1);
  for (const beat of tl.beats) {
    const toks = beat.moves.map((m) => m.tok);
    assert.equal(new Set(toks).size, toks.length);
  }
});

test("a narrow figure turns the grid so data flows top to bottom", () => {
  const nodes = {
    a: goroutine({ label: "producer", pos: [0, 0] as const, main: true, program: function* () {} }),
    c: channel({ label: "ch", pos: [1, 0] as const, cap: 2 }),
    b: goroutine({ label: "consumer", pos: [2, 0] as const, program: function* () {} }),
  };
  const wide = layout(model(nodes), [], 640);
  const narrow = layout(model(nodes), [], 300);
  assert.equal(wide.portrait, false);
  assert.equal(narrow.portrait, true);
  assert.ok(wide.nodes.a!.x < wide.nodes.b!.x);
  assert.ok(narrow.nodes.a!.y < narrow.nodes.b!.y);
});

test("remake gives a channel variable a fresh, open channel", () => {
  const run = runModel(
    model({
      done: channel({ label: "done", pos: at(), cap: 0 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          yield close("done");
          yield remake("done");
          yield close("done");
        },
      }),
    }),
  );
  assert.equal(run.outcome, "ok");
  assert.equal(run.world.ch.done!.closed, true);
});

// ---------------------------------------------------------------------------
// Fixes from the independent review
// ---------------------------------------------------------------------------

test("a yielded value that is not an operation is an error, not a no-op", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 1 }),
      g: goroutine({
        label: "g",
        pos: at(),
        main: true,
        program: function* () {
          // A forgotten `yield*` on range() yields the generator itself.
          yield range("ch", function* () {}) as never;
        },
      }),
    }),
  );
  assert.ok(run.errors.some((e) => /not an operation/.test(e)), run.errors.join("|"));
});

test("the clock stops when the last goroutine returns", () => {
  const run = runModel(
    model({
      ctx: context({ label: "ctx", pos: at(), deadline: 500 }),
      t: timer({ label: "t", pos: at(), after: 300 }),
      g: goroutine({ label: "g", pos: at(), main: true, program: function* () { yield start("t"); yield work(10); } }),
    }),
  );
  assert.equal(run.t, 10);
});

test("exit empties every wait queue", () => {
  const run = runModel(
    model({
      ch: channel({ label: "ch", pos: at(), cap: 0 }),
      a: goroutine({ label: "a", pos: at(), program: function* () { yield recv("ch"); } }),
      m: goroutine({ label: "m", pos: at(), main: true, program: function* () { yield sleep(5); yield exit("os.Exit(1)"); } }),
    }),
  );
  assert.equal(run.outcome, "exit");
  assert.equal(run.world.ch.ch!.receivers, 0);
});

test("everything blocked at `until` is a deadlock, not a timeout", () => {
  const run = runModel(
    model(
      {
        ch: channel({ label: "ch", pos: at(), cap: 0 }),
        a: goroutine({ label: "a", pos: at(), main: true, program: function* () { yield sleep(100); yield recv("ch"); } }),
      },
      { until: 100 },
    ),
  );
  assert.equal(run.outcome, "deadlock");
});

test("start order at t = 0 follows the seed", () => {
  const orders = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const order: number[] = [];
    runModel(
      model({
        ch: channel({ label: "ch", pos: at(), cap: 4 }),
        w: goroutine({ label: "w", pos: at(), count: 4, program: function* ({ i }) { order.push(i); yield send("ch", i); } }),
        m: goroutine({ label: "m", pos: at(), main: true, program: function* () { yield sleep(1); } }),
      }),
      { seed },
    );
    orders.add(order.join(""));
  }
  assert.ok(orders.size > 1, "one start order for every seed");
});

test("a fractional position on the last column stays on the canvas", () => {
  const nodes = {
    a: goroutine({ label: "a", pos: [0, 0] as const, main: true, program: function* () {} }),
    ch: channel({ label: "ch", pos: [1.5, 0] as const, cap: 1 }),
  };
  const lay = layout(model(nodes), [], 640);
  assert.equal(lay.scale, 1);
});

test("a scaled-down layout keeps the orientation chosen at the real width", () => {
  const nodes = {
    a: goroutine({ label: "producer", pos: [0, 0] as const, main: true, program: function* () {} }),
    b: channel({ label: "ch", pos: [1, 0] as const, cap: 2 }),
    c: goroutine({ label: "consumer", pos: [2, 0] as const, program: function* () {} }),
  };
  assert.equal(layout(model(nodes), [], 274).portrait, true);
});

test("slice cells stay inside their background", () => {
  for (const width of [300, 640, 1200]) {
    const lay = layout(
      model({
        values: slice({ label: "values", pos: [0, 0], size: 20 }),
      }),
      [],
      width,
    );
    const node = lay.nodes.values!;
    const slots = lay.slots.values!;
    for (const slot of slots) {
      assert.ok(slot.x - slot.w / 2 >= node.x - node.w / 2, `${width}px: left cell outside background`);
      assert.ok(slot.x + slot.w / 2 <= node.x + node.w / 2, `${width}px: right cell outside background`);
      assert.ok(slot.y - slot.h / 2 >= node.y - node.h / 2, `${width}px: top cell outside background`);
      assert.ok(slot.y + slot.h / 2 <= node.y + node.h / 2, `${width}px: bottom cell outside background`);
    }
  }
});
