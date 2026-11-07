// 27 is a timing problem. The scaffold's heartbeat is decorative and its
// watcher trusts one flat whole-job deadline, so a stall is caught late and
// a healthy job is killed early. The Goal resets its timer on every sign of
// life, so only silence lets it fire.

import {
  append,
  channel,
  close,
  defineViz,
  go,
  goroutine,
  onRecv,
  onSend,
  recv,
  reset,
  select,
  SIGNAL,
  slice,
  start,
  stop,
  timer,
  work,
} from "../engine/ops.ts";
import type { Model, Op, RunSummary, SelectResult, TestDef } from "../engine/model.ts";

const K = {
  unitMs: {
    value: 400,
    file: "mockworker.go",
    text: "const UnitDuration = 400 * time.Millisecond",
  },
  pulseMs: {
    value: 100,
    file: "main.go",
    text: "const workerPulseInterval = 100 * time.Millisecond",
  },
  perPulseMs: {
    value: 300,
    file: "check_test.go",
    text: "const testPerPulseTimeout = 300 * time.Millisecond",
  },
  units: { value: 5, file: "check_test.go", text: "const workUnits = 5" },
  stallAfter: { value: 2, file: "check_test.go", text: "stallAfter = 2" },
  // The test's promptness bound adds two pulse intervals of slack.
  slack: { value: 2, file: "check_test.go", text: "2*workerPulseInterval" },
  heartbeatCap: {
    value: 1,
    file: "main.go",
    text: "hb := make(chan struct{}, 1)",
  },
} as const;

const N = K.units.value;
const unitMs = K.unitMs.value;
const pulseMs = K.pulseMs.value;
const perPulseMs = K.perPulseMs.value;
// SimulateUnit splits a healthy unit into pulseInterval slices and calls
// checkIn after every slice but the last.
const slices = unitMs / pulseMs;
// The scaffold's flat deadline: perPulseTimeout * workUnits.
const flatMs = perPulseMs * N;
// TestStallDetectedPromptly: unit 2 starts at 2*UnitDuration; the bound adds
// one perPulseTimeout and 2*workerPulseInterval.
const stallStartsAt = K.stallAfter.value * unitMs;
const deadline = stallStartsAt + perPulseMs + K.slack.value * pulseMs;

const tests = {
  noStall: {
    name: "TestNoStallCompletesSuccessfully",
    short: "no stall",
    judge: (run: RunSummary) => run.vars.err !== 1 && run.world.slice.collected?.every((cell) => cell !== null) === true,
  },
  stall: {
    name: "TestStallDetectedPromptly",
    short: "stall caught",
    // WorkWithTimeout returns at the end of the run: the stalled worker
    // leaves at the same instant, when done closes.
    judge: (run: RunSummary) => run.vars.err === 1 && run.t >= stallStartsAt && run.t <= deadline,
  },
} satisfies Record<string, TestDef>;

// Positions shared by every scene: the worker on the left, the watcher on
// the right, heartbeat on the upper path and results on the lower one.
const P = {
  worker: [0, 0],
  done: [0, 1],
  heartbeat: [1, 0],
  results: [1.8, 0.95],
  timer: [3, 0],
  watcher: [3, 1],
  collected: [4, 1],
} as const;

const doneCh = channel({ label: "done", pos: P.done, cap: 0 });
const resultsCh = channel({ label: "results", pos: P.results, cap: 0 });
const collected = slice({ label: "collected", pos: P.collected, size: N });

// The scaffold's DoWork goroutine. stallAt is the unit SetStallUnit picked,
// or -1. `checkDone` models SimulateUnit's per-slice select on done; only a
// run where done closes during a healthy unit needs it.
function scaffoldWorker(stallAt: number, checkDone: boolean) {
  return function* (): Generator<Op, void, SelectResult> {
    // The single startup pulse lands in hb's one slot; nobody reads it.
    const first = yield select([onSend("heartbeat", SIGNAL), onRecv("done")], {
      at: "case hb <- struct{}{}:",
    });
    if (first.i === 1) return void (yield close("results"));
    for (let i = 0; i < N; i++) {
      if (i === stallAt) {
        // A stalled unit waits on a 24 h timer or done, and done wins.
        yield recv("done", { at: "SimulateUnit(" });
        yield close("results");
        return;
      }
      for (let s = 0; s < slices; s++) {
        if (checkDone) {
          const r = yield select([onRecv("done")], {
            default: true,
            at: "SimulateUnit(",
          });
          if (r.i === 0) return void (yield close("results"));
        }
        // checkIn is a no-op, so nothing is sent between slices.
        yield work(pulseMs, "SimulateUnit");
      }
      const r = yield select([onSend("results", i), onRecv("done")], {
        at: "case res <- i:",
      });
      if (r.i === 1) return void (yield close("results"));
    }
    yield close("results");
  };
}

// The scaffold's WorkWithTimeout: one flat time.After, and no heartbeat case.
function scaffoldWatcher(showsDoWork: boolean) {
  return function* ({ vars }: { vars: Record<string, number> }): Generator<Op, void, SelectResult> {
    yield go("worker", { at: showsDoWork ? "DoWork(" : undefined });
    yield start("timedOut", { at: "time.After(" });
    for (;;) {
      const r = yield select([onRecv("results"), onRecv("timedOut")]);
      if (r.i === 0) {
        if (!r.ok) return void (yield close("done"));
        yield append("collected", r.tok!, { at: "case r, ok := <-results:" });
        continue;
      }
      vars.err = 1;
      // defer close(done) runs as WorkWithTimeout returns the error.
      yield close("done", { at: "return nil, fmt.Errorf(" });
      return;
    }
  };
}

// The fixed DoWork goroutine: checkIn sends a pulse between slices.
function fixedWorker(stallAt: number) {
  return function* (): Generator<Op, void, SelectResult> {
    for (let i = 0; i < N; i++) {
      if (i === stallAt) {
        // The stalled unit never calls checkIn: heartbeat goes quiet.
        yield recv("done", { at: "SimulateUnit(" });
        yield close("results");
        return;
      }
      for (let s = 0; s < slices; s++) {
        yield work(pulseMs, "SimulateUnit");
        if (s < slices - 1) {
          const r = yield select([onSend("heartbeat", SIGNAL), onRecv("done")], { at: "case hb <- struct{}{}:" });
          if (r.i === 1) return void (yield close("results"));
        }
      }
      const r = yield select([onSend("results", i), onRecv("done")], {
        at: "case res <- i:",
      });
      if (r.i === 1) return void (yield close("results"));
    }
    yield close("results");
  };
}

// The fixed WorkWithTimeout: every heartbeat or result resets the timer.
// `deferStop` adds the solution's deferred timer.Stop(); the Goal stays at
// the README's level, which a time.After-per-loop solution also meets.
function fixedWatcher(deferStop: boolean) {
  return function* ({ vars }: { vars: Record<string, number> }): Generator<Op, void, SelectResult> {
    yield go("worker", { at: deferStop ? "DoWork(" : undefined });
    yield start("timer", { at: deferStop ? "time.NewTimer(" : undefined });
    for (;;) {
      const r = yield select([onRecv("heartbeat"), onRecv("results"), onRecv("timer")]);
      if (r.i === 0) {
        yield reset("timer");
      } else if (r.i === 1) {
        if (!r.ok) {
          if (deferStop) yield stop("timer", { at: "return collected, nil" });
          yield close("done", {
            at: deferStop ? "return collected, nil" : undefined,
          });
          return;
        }
        yield append("collected", r.tok!);
        yield reset("timer");
      } else {
        vars.err = 1;
        if (deferStop) yield stop("timer");
        yield close("done");
        return;
      }
    }
  };
}

function scaffoldModel(stallAt: number, checkDone: boolean): Pick<Model, "nodes"> {
  return {
    nodes: {
      done: doneCh,
      worker: goroutine({
        label: "worker",
        pos: P.worker,
        spawned: true,
        program: scaffoldWorker(stallAt, checkDone),
      }),
      heartbeat: channel({
        label: "heartbeat",
        pos: P.heartbeat,
        cap: K.heartbeatCap.value,
      }),
      results: resultsCh,
      timedOut: timer({ label: "timedOut", pos: P.timer, after: flatMs }),
      watcher: goroutine({
        label: "watcher",
        pos: P.watcher,
        main: true,
        program: scaffoldWatcher(checkDone === false),
      }),
      collected,
    },
  };
}

function fixedModel(stallAt: number, deferStop: boolean): Pick<Model, "nodes"> {
  return {
    nodes: {
      done: doneCh,
      worker: goroutine({
        label: "worker",
        pos: P.worker,
        spawned: true,
        program: fixedWorker(stallAt),
      }),
      heartbeat: channel({ label: "heartbeat", pos: P.heartbeat, cap: 0 }),
      results: resultsCh,
      timer: timer({ label: "timer", pos: P.timer, after: perPulseMs }),
      watcher: goroutine({
        label: "watcher",
        pos: P.watcher,
        main: true,
        program: fixedWatcher(deferStop),
      }),
      collected,
    },
  };
}

// Both Problem scenes run TestStallDetectedPromptly and share one door.
const stallClock = {
  unit: "ms",
  budget: { at: deadline, label: "deadline" },
} as const;

export default defineViz({
  schema: 3,
  exercise: "27-heartbeats",
  // One README fence draws both states, so both Problem tiers pin that fence.
  diagrams: { today: "fnv1a:b9c3ebfe", goal: "fnv1a:b9c3ebfe" },
  constants: K,
  anchors: [
    {
      file: "main.go",
      text: "timedOut := time.After(perPulseTimeout * time.Duration(workUnits))",
    },
  ],
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The heartbeat pulses once and nobody reads it. The flat ${flatMs} ms timer catches the ${stallStartsAt} ms stall only at ${flatMs} ms, past the ${deadline} ms deadline.`,
      model: {
        ...scaffoldModel(K.stallAfter.value, false),
        insight: `The worker's one heartbeat sits unread in its slot. The watcher waits only on results and timedOut, armed once for the whole job, so the stall at ${stallStartsAt} ms goes unnoticed until ${flatMs} ms.`,
        stops: [
          {
            when: { op: "select", g: "worker" },
            say: "The one heartbeat goes into the buffer. The watcher never receives from heartbeat.",
          },
          {
            when: { op: "block", g: "worker" },
            say: `Unit 2 stalls at ${stallStartsAt} ms. No result comes, but timedOut still counts down to ${flatMs} ms.`,
          },
          {
            when: { op: "fire", node: "timedOut" },
            say: `timedOut fires at ${flatMs} ms, ${flatMs - deadline} ms past the test's ${deadline} ms deadline.`,
          },
        ],
        tests: { stall: tests.stall },
        clock: stallClock,
        code: {
          file: "main.go",
          text: `
@worker \t\tselect {
@worker \t\tcase hb <- struct{}{}:
…
@worker \t\tcheckIn := func() bool { return true }
…
@worker \t\t\tif !SimulateUnit(done, i, pulseInterval, checkIn) {
…
@worker \t\t\tcase res <- i:
…
@watcher \t_, results := DoWork(done, workerPulseInterval, workUnits)
…
@watcher \ttimedOut := time.After(perPulseTimeout * time.Duration(workUnits))
…
@watcher \t\tselect {
@watcher \t\tcase r, ok := <-results:
…
@watcher \t\tcase <-timedOut:
@watcher \t\t\treturn nil, fmt.Errorf("work timed out after %s", perPulseTimeout*time.Duration(workUnits))`,
        },
        expect: { outcome: "ok", t: flatMs, tests: { stall: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Every heartbeat or result resets the watcher's ${perPulseMs} ms timer, so the ${stallStartsAt} ms stall is caught at ${stallStartsAt + perPulseMs} ms.`,
      model: {
        ...fixedModel(K.stallAfter.value, false),
        insight: `The worker pulses between slices of each unit, and every pulse or result resets the timer. Once unit 2 stalls, nothing resets it, so it fires ${perPulseMs} ms after the last sign of life.`,
        stops: [
          {
            when: { op: "reset", node: "timer" },
            say: `Each heartbeat resets the timer to ${perPulseMs} ms, so it never gets close to firing.`,
          },
          {
            when: { op: "block", g: "worker" },
            say: `Unit 2 stalls at ${stallStartsAt} ms: no heartbeat, no result, so nothing resets the timer.`,
          },
          {
            when: { op: "fire", node: "timer" },
            say: `After ${perPulseMs} ms of silence the timer fires at ${stallStartsAt + perPulseMs} ms, inside the ${deadline} ms deadline.`,
          },
        ],
        tests: { stall: tests.stall },
        clock: stallClock,
        expect: {
          outcome: "ok",
          t: stallStartsAt + perPulseMs,
          tests: { stall: "pass" },
        },
      },
    },
    {
      id: "flat",
      chip: "Flat",
      tier: "inside",
      summary: `With no stall, the naive flat ${flatMs} ms deadline fires in the middle of unit 3 of a healthy ${N * unitMs} ms job, so the no-stall test fails.`,
      model: {
        ...scaffoldModel(-1, true),
        insight: `The other half of the flat deadline's trouble: a healthy job needs ${N * unitMs} ms, but timedOut fires at ${flatMs} ms. No whole-job deadline can be under the stall test's ${deadline} ms and over a healthy job's ${N * unitMs} ms at once.`,
        stops: [
          {
            when: { op: "fire", node: "timedOut" },
            say: `timedOut fires at ${flatMs} ms with 3 of ${N} results in. The worker was fine, only slow.`,
          },
        ],
        tests: { noStall: tests.noStall },
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@worker \t\tcase hb <- struct{}{}: // one pulse, ever, right at startup
…
@worker \t\tcheckIn := func() bool { return true } // BUG: never actually sends a heartbeat
…
@worker \t\t\tif !SimulateUnit(done, i, pulseInterval, checkIn) {
…
@worker \t\t\tcase res <- i:
…
@watcher timedOut := time.After(perPulseTimeout * time.Duration(workUnits))
@watcher for {
@watcher \tselect {
@watcher \tcase r, ok := <-results:
@watcher \t\t...
@watcher \tcase <-timedOut:
@watcher \t\treturn nil, fmt.Errorf("work timed out after %s", ...)`,
        },
        expect: { outcome: "ok", t: flatMs, tests: { noStall: "fail" } },
      },
    },
    {
      id: "healthy",
      chip: "Healthy",
      tier: "inside",
      summary: `With no stall, the worker pulses every ${pulseMs} ms and the timer resets each time, so the ${N * unitMs} ms job finishes with all ${N} results.`,
      model: {
        ...fixedModel(-1, true),
        insight: `checkIn sends a pulse between slices, and the watcher resets the timer on each pulse and each result. The gap never reaches ${perPulseMs} ms, so a job of any length runs to the end.`,
        stops: [
          {
            when: { op: "reset", node: "timer", nth: 2 },
            say: `Pulses come every ${pulseMs} ms. The timer restarts at ${perPulseMs} ms each time.`,
          },
          {
            when: { op: "close", node: "results" },
            say: `All ${N} results are in at ${N * unitMs} ms. The worker closes results; the timer never fired.`,
          },
        ],
        tests: { noStall: tests.noStall },
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@worker \t\tcheckIn := func() bool {
@worker \t\t\tselect {
@worker \t\t\tcase hb <- struct{}{}:
…
@worker \t\t\tif !SimulateUnit(done, i, pulseInterval, checkIn) {
…
@worker \t\t\tcase res <- i:
…
@watcher \theartbeat, results := DoWork(done, workerPulseInterval, workUnits)
…
@watcher \ttimer := time.NewTimer(perPulseTimeout)
@watcher \tdefer timer.Stop()
…
@watcher \t\tselect {
@watcher \t\tcase <-heartbeat:
@watcher \t\t\ttimer.Reset(perPulseTimeout)
@watcher
@watcher \t\tcase r, ok := <-results:
@watcher \t\t\tif !ok {
@watcher \t\t\t\treturn collected, nil
@watcher \t\t\t}
@watcher \t\t\tcollected = append(collected, r)
@watcher \t\t\ttimer.Reset(perPulseTimeout)`,
        },
        expect: { outcome: "ok", t: N * unitMs, tests: { noStall: "pass" } },
      },
    },
  ],
});
