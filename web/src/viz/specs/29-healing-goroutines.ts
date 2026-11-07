// 29 is a timing problem. The scaffold hands the ward's heartbeat straight
// back, so when the one ward generation wedges after five pulses, the
// caller hears nothing until its 5 s deadline. The fix is a steward
// goroutine that forwards pulses, restarts the ward 350 ms after the last
// one with a fresh wardDone, and stops when the caller closes done.
//
// The engine has no periodic ticker, so a ward's time.Ticker is a timer the
// ward re-arms the instant it ticks. Generations never overlap, so one
// ticker node stands for the live generation's own. At each restart the
// steward remakes wardDone and, through ward.Start, the ward's heartbeat.

import {
  channel,
  close,
  defineViz,
  fact,
  fail,
  go,
  goroutine,
  inc,
  notify,
  onRecv,
  onSend,
  pass,
  recv,
  remake,
  reset,
  select,
  SIGNAL,
  sleep,
  start,
  stop,
  timer,
} from "../engine/ops.ts";
import type { Op, SelectResult } from "../engine/model.ts";

const K = {
  pulseMs: { value: 100, file: "check_test.go", text: "100 * time.Millisecond" },
  timeoutMs: { value: 350, file: "check_test.go", text: "350 * time.Millisecond" },
  pulsesBeforeWedge: { value: 5, file: "check_test.go", text: "pulsesBeforeWedge = 5" },
  wantPulses: { value: 12, file: "check_test.go", text: "12 // more than one generation's worth" },
  deadlineS: { value: 5, file: "check_test.go", text: "time.After(5 * time.Second)" },
  verdictWait: { value: 5, file: "check_test.go", text: "time.Sleep(5 * timeout)" },
} as const;

const pulseMs = K.pulseMs.value;
const timeoutMs = K.timeoutMs.value;
const wedgeAfter = K.pulsesBeforeWedge.value;
const wantPulses = K.wantPulses.value;
// Twelve pulses at five per generation need three generations.
const gens = Math.ceil(wantPulses / wedgeAfter);
const deadlineMs = K.deadlineS.value * 1000;
// Generation k starts when the steward's timer fires, 350 ms after the
// previous generation's last pulse.
const genStart = (k: number): number => k * (wedgeAfter * pulseMs + timeoutMs);
const lastPulseMs = genStart(gens - 1) + (wantPulses - (gens - 1) * wedgeAfter) * pulseMs;
const verdictMs = lastPulseMs + K.verdictWait.value * timeoutMs;

// MockWard.Start's goroutine: tick, pulse without blocking, and after
// pulsesBeforeWedge pulses return without closing heartbeat.
function wardProgram(doneOf: (i: number) => string) {
  return function* ({ i }: { i: number }): Generator<Op, void, SelectResult> {
    yield start("ticker");
    let pulses = 0;
    for (;;) {
      const r = yield select([onRecv(doneOf(i)), onRecv("ticker")]);
      if (r.i === 0) {
        yield stop("ticker");
        return;
      }
      // A time.Ticker re-arms itself at every tick.
      yield reset("ticker");
      pulses++;
      // select { case heartbeat <- struct{}{}: default: }
      yield notify("wardHeartbeat", SIGNAL);
      if (pulses >= wedgeAfter) {
        // Wedged: the goroutine just returns; defer ticker.Stop() runs.
        yield stop("ticker");
        return;
      }
    }
  };
}

const ticker = (pos: readonly [number, number]) => timer({ label: "ticker", after: pulseMs, pos });

export default defineViz({
  schema: 3,
  exercise: "29-healing-goroutines",
  // One README fence draws both states, so both Problem tiers pin that fence.
  diagrams: { today: "fnv1a:0d54a23f", goal: "fnv1a:0d54a23f" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The steward returns the ward's heartbeat directly. The ward wedges after ${wedgeAfter} pulses. The caller hears nothing until its ${K.deadlineS.value} s deadline.`,
      model: {
        nodes: {
          done: channel({ label: "done", pos: [1, 1], cap: 0 }),
          // The scaffold starts exactly one generation.
          ward: goroutine({ label: "ward", pos: [0, 0], count: 1, base: 1, spawned: true, program: wardProgram(() => "done") }),
          ticker: ticker([0, 1]),
          wardHeartbeat: channel({ label: "heartbeat", pos: [1, 0], cap: 1 }),
          received: fact({ label: "received", pos: [3, 0], value: 0, limit: wantPulses }),
          caller: goroutine({
            label: "caller",
            pos: [2, 0],
            main: true,
            program: function* (): Generator<Op, void, SelectResult> {
              // steward(done, pulseInterval) is ward(done, pulseInterval).
              yield go("ward[0]", { at: "return ward(done, pulseInterval)" });
              yield start("deadline");
              for (;;) {
                const r = yield select([onRecv("wardHeartbeat"), onRecv("deadline")]);
                if (r.i === 1) {
                  yield fail("restart");
                  return;
                }
                yield inc("received");
              }
            },
          }),
          deadline: timer({ label: "deadline", pos: [2, 1], after: deadlineMs }),
        },
        insight: `The caller reads the ward's own heartbeat. The ward gets the caller's own done. After ${wedgeAfter} pulses the ward wedges. Nothing notices or starts a new ward. The received count stays at ${wedgeAfter}.`,
        stops: [
          {
            when: { op: "return", g: "ward" },
            say: `The first ward wedges after ${wedgeAfter} pulses and goes silent. Nothing watches it, so no new ward starts.`,
          },
          {
            when: { op: "fire", node: "deadline" },
            say: `At ${deadlineMs} ms the deadline fires with ${wedgeAfter} of ${wantPulses} pulses. The restart test fails.`,
          },
        ],
        tests: { restart: { name: "TestStewardRestartsWedgedWard", short: "restart" } },
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@caller func NewSteward(timeout time.Duration, ward StartGoroutineFn) StartGoroutineFn {
@caller \treturn func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
…
@caller \t\treturn ward(done, pulseInterval)
@caller \t}
@caller }`,
        },
        expect: { outcome: "ok", t: deadlineMs, tests: { restart: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `A steward forwards every pulse. If no pulse arrives for ${timeoutMs} ms, it closes wardDone and starts a fresh ward.`,
      model: {
        nodes: {
          ward: goroutine({ label: "ward", pos: [0, 0], count: gens, base: 1, spawned: true, program: wardProgram(() => "wardDone") }),
          wardHeartbeat: channel({ label: "heartbeat", pos: [1, 0], cap: 1 }),
          steward: goroutine({
            label: "steward",
            pos: [2, 0],
            spawned: true,
            program: function* (): Generator<Op, void, SelectResult> {
              let k = 0;
              // The first generation: wardDone and its heartbeat start fresh.
              yield go("ward[0]");
              yield start("timeout");
              for (;;) {
                const r = yield select([onRecv("done"), onRecv("wardHeartbeat"), onRecv("timeout")]);
                if (r.i === 0) {
                  yield close("wardDone");
                  // defer close(heartbeat)
                  yield close("ownHeartbeat");
                  return;
                }
                if (r.i === 1) {
                  const f = yield select([onSend("ownHeartbeat", r.tok!), onRecv("done")]);
                  if (f.i === 1) {
                    yield close("wardDone");
                    yield close("ownHeartbeat");
                    return;
                  }
                  yield reset("timeout");
                  continue;
                }
                // No pulse for the whole timeout: close the old wardDone
                // without waiting, then start the next generation with a
                // fresh wardDone; ward.Start makes it a fresh heartbeat.
                yield close("wardDone");
                yield remake("wardDone");
                yield remake("wardHeartbeat");
                k++;
                yield go(`ward[${k}]`);
                yield reset("timeout");
              }
            },
          }),
          ownHeartbeat: channel({ label: "own heartbeat", pos: [3, 0], cap: 0 }),
          caller: goroutine({
            label: "caller",
            pos: [4, 0],
            main: true,
            // The test's 5 s deadline never fires in this run, so the
            // caller's select is a plain receive here.
            program: function* () {
              yield go("steward");
              for (let n = 0; n < wantPulses; n++) {
                yield recv("ownHeartbeat");
              }
              yield close("done");
              // time.Sleep(5 * timeout): no generation may start after done.
              yield sleep(K.verdictWait.value * timeoutMs);
              yield pass("restart");
            },
          }),
          ticker: ticker([0, 1]),
          wardDone: channel({ label: "wardDone", pos: [1, 1], cap: 0 }),
          timeout: timer({ label: "timeout", pos: [2, 1], after: timeoutMs }),
          done: channel({ label: "done", pos: [3, 1], cap: 0 }),
        },
        insight: `Each pulse resets the ${timeoutMs} ms timeout. When a ward wedges, the timeout fires. The steward closes wardDone without waiting. It makes a fresh one and starts the next ward.`,
        stops: [
          {
            when: { op: "return", g: "ward" },
            say: `ward-1 wedges after ${wedgeAfter} pulses. The steward's timeout keeps counting from the last pulse.`,
          },
          {
            when: { op: "go", g: "steward" },
            say: `At ${genStart(1)} ms the timeout fires. The steward closes wardDone, makes a fresh one, and starts ward-2.`,
          },
          {
            when: { op: "return", g: `ward[${gens - 1}]` },
            say: `After ${wantPulses} pulses the caller closes done. The steward closes wardDone and stops. ward-${gens} returns.`,
          },
        ],
        tests: { restart: { name: "TestStewardRestartsWedgedWard", short: "restart" } },
        clock: { unit: "ms" },
        expect: { outcome: "ok", t: verdictMs, tests: { restart: "pass" } },
      },
    },
  ],
});
