// 14 is about duplication. The scaffold returns `in` twice, so out1 and out2
// are the same channel as `in`: two readers race for every value, and each
// value reaches ONE of them. A tee goroutine reads `in` once and holds each
// value until BOTH outputs have taken it, so a slow reader delays the stream
// but never loses a value. `done` is checked in the outer receive and in the
// inner send loop, so closing it ends the tee at any point.
//
// Two tests, two runs. TestTeeDuplicatesToBothConsumers (10 values, a fast
// and a slow reader) is the run of Today and Goal. TestTeeStopsOnDone (a
// 50-value sensor, four reads, then close(done)) is the run of the inside
// scene; the scaffold fails both. A scene judges only the test whose run it is.
//
// Not drawn: the `done` channel in the duplicating test (it is closed by a
// deferred call after every goroutine has ended), the real-time 100 ms window
// of assertClosesPromptly, and TestTeeStopsOnDoneRace (the same run, 20 times).

import {
  add,
  append,
  channel,
  close,
  defineViz,
  done,
  fail,
  go,
  goroutine,
  onRecv,
  onSend,
  pass,
  range,
  recv,
  select,
  sleep,
  send,
  slice,
  wait,
  waitgroup,
} from "../engine/ops.ts";
import type { Model, Op, Params, SelectCase, SelectResult, Self, TestDef } from "../engine/model.ts";

// What the engine sends back into a program: a RecvResult, a SelectResult, or
// nothing. `Program` in model.ts declares the same `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, void, any>;

// Every number names its source in the committed exercise.
const K = {
  items: { value: 10, file: "check_test.go", text: "in := StartSensor(10)" },
  interval: { value: 5, file: "mocksensor.go", text: "const SensorInterval = 5 * time.Millisecond" },
  slowMs: { value: 2, file: "check_test.go", text: "time.Sleep(2 * time.Millisecond)" },
  stopItems: { value: 50, file: "check_test.go", text: "in := StartSensor(50)" },
} as const;

const N = K.items.value;
// A reader slower than the sensor: twice its interval.
const SLOWER = 2 * K.interval.value;

const tests: Record<string, TestDef> = {
  both: {
    name: "TestTeeDuplicatesToBothConsumers",
    short: "both get 0..9",
    // reflect.DeepEqual(fast, want) and reflect.DeepEqual(slow, want).
    judge: (run) => run.vars.fast === N && run.vars.slow === N && run.vars.bad === undefined,
  },
};

const stopTests: Record<string, TestDef> = {
  stops: { name: "TestTeeStopsOnDone", short: "closes on done" },
};

// The sensor as mocksensor.go writes it: sleep one interval, send, repeat,
// then close.
function sensorProgram(count: number, lines: boolean): () => Gen {
  return function* () {
    for (let i = 0; i < count; i++) {
      yield sleep(K.interval.value, lines ? { at: "time.Sleep(SensorInterval)" } : {});
      yield send("in", i, lines ? { at: "out <- i" } : {});
    }
    yield close("in", lines ? { at: "close(out)" } : {});
  };
}

// A reader as the test writes it: range over its channel, optionally sleep,
// append to its list. It checks each value against 0, 1, 2, … as the test's
// DeepEqual does.
function reader(key: "fast" | "slow", from: string, sleepMs: number) {
  return function* ({ vars }: Self): Gen {
    yield* range(from, function* (r) {
      if (sleepMs > 0) yield sleep(sleepMs);
      const k = vars[key] ?? 0;
      if (r.v !== k) vars.bad = 1;
      vars[key] = k + 1;
      yield append(key, r.tok!);
    });
    yield done("wg");
  };
}

// The tee goroutine as the README describes it, and the solution writes it:
// receive from in, then send the value to whichever output has not taken it,
// until both have. `withDone` adds the done case to both selects.
function tee(withDone: boolean, lines: boolean) {
  const at = (text: string): { at: string } | Record<string, never> => (lines ? { at: text } : {});
  return function* (): Gen {
    outer: for (;;) {
      const inCases: SelectCase[] = withDone ? [onRecv("done"), onRecv("in")] : [onRecv("in")];
      const got: SelectResult = yield select(inCases, at("case v, ok = <-in:"));
      if (withDone && got.i === 0) break;
      if (!got.ok) break;
      let want1 = true;
      let want2 = true;
      while (want1 || want2) {
        const cases: SelectCase[] = [];
        const which: number[] = [];
        if (want1) {
          cases.push(onSend("out1", got.v));
          which.push(1);
        }
        if (want2) {
          cases.push(onSend("out2", got.v));
          which.push(2);
        }
        if (withDone) cases.push(onRecv("done"));
        const s: SelectResult = yield select(cases, at("case out1Ch <- v:"));
        if (withDone && s.i === cases.length - 1) break outer;
        if (which[s.i] === 1) want1 = false;
        else want2 = false;
      }
    }
    // defer close(out2) runs before defer close(out1).
    yield close("out2", at("defer close(out2)"));
    yield close("out1", at("defer close(out1)"));
  };
}

const SOLUTION = `
@tee func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
@tee 	out1 := make(chan int)
@tee 	out2 := make(chan int)
@tee
@tee 	go func() {
@tee 		defer close(out1)
@tee 		defer close(out2)
@tee
@tee 		for {
@tee 			var v int
@tee 			var ok bool
@tee
@tee 			select {
@tee 			case <-done:
@tee 				return
@tee 			case v, ok = <-in:
@tee 				if !ok {
@tee 					return
@tee 				}
@tee 			}
@tee
…
@tee 			out1Ch, out2Ch := out1, out2
@tee 			for out1Ch != nil || out2Ch != nil {
@tee 				select {
@tee 				case out1Ch <- v:
@tee 					out1Ch = nil
@tee 				case out2Ch <- v:
@tee 					out2Ch = nil
@tee 				case <-done:
@tee 					return
@tee 				}
@tee 			}
@tee 		}
@tee 	}()
@tee
@tee 	return out1, out2
@tee }`;

// The test goroutine: StartSensor, Tee, two readers, wg.Wait().
function mainProgram(withTee: boolean) {
  return function* (): Gen {
    yield go("sensor");
    if (withTee) yield go("tee");
    yield add("wg", 1);
    yield go("reader1");
    yield add("wg", 1);
    yield go("reader2");
    yield wait("wg");
  };
}

function readers(from1: string, from2: string, slowMs: number, pos: readonly [number, number][]) {
  return {
    reader1: goroutine({ label: "reader 1", pos: pos[0]!, spawned: true, program: reader("fast", from1, 0) }),
    reader2: goroutine({ label: "reader 2", pos: pos[1]!, spawned: true, program: reader("slow", from2, slowMs) }),
  };
}

function goal(P: Params): Model {
  const slowMs = Number(P.slowMs);
  const slower = slowMs > K.interval.value;
  const insight =
    slowMs === 0
      ? `Both readers keep up. The tee goroutine reads each value from in once and sends it to out1 and to out2, so each reader ends with all ${N} values.`
      : slower
        ? `Reader 2 needs ${slowMs} ms per value, more than the sensor's ${K.interval.value} ms. The tee goroutine holds each value until out2 takes it, and the sensor waits behind it. Reader 2 still gets all ${N}; only the run gets longer.`
        : `Reader 2 sleeps ${slowMs} ms per value, but is back before the next one arrives. The tee goroutine sends each value to out1 and to out2, so each reader ends with all ${N} values.`;
  return {
    nodes: {
      main: goroutine({ label: "main", pos: [4, 1], main: true, program: mainProgram(true) }),
      wg: waitgroup({ label: "wg", pos: [3, 1] }),
      sensor: goroutine({ label: "sensor", pos: [0, 1], spawned: true, program: sensorProgram(N, false) }),
      in: channel({ label: "in", pos: [1, 1], cap: 0 }),
      tee: goroutine({ label: "tee", pos: [2, 1], spawned: true, program: tee(false, false) }),
      out1: channel({ label: "out1", pos: [3, 0], cap: 0 }),
      out2: channel({ label: "out2", pos: [3, 2], cap: 0 }),
      ...readers("out1", "out2", slowMs, [[4, 0], [4, 2]]),
      fast: slice({ label: "fast", pos: [5, 0], size: N }),
      slow: slice({ label: "slow", pos: [5, 2], size: N }),
    },
    insight,
    stops: slower
      ? [{ when: { op: "block", g: "tee" }, say: "out1 has this value, but reader 2 is still busy. The tee goroutine holds it for out2." }]
      : [],
    tests,
    clock: { unit: "ms" },
    expect: { outcome: "ok", tests: { both: "pass" } },
  };
}

export default defineViz({
  schema: 3,
  exercise: "14-tee-channel",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:07fb7715", goal: "fnv1a:07fb7715" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `Tee returns in twice, so both readers receive from one channel: each value reaches one reader, and neither list holds all ${N}.`,
      model: {
        nodes: {
          main: goroutine({ label: "main", pos: [2, 1], main: true, program: mainProgram(false) }),
          wg: waitgroup({ label: "wg", pos: [3, 1] }),
          sensor: goroutine({ label: "sensor", pos: [0, 1], spawned: true, program: sensorProgram(N, false) }),
          in: channel({ label: "in", pos: [1, 1], cap: 0 }),
          ...readers("in", "in", K.slowMs.value, [[2, 0], [2, 2]]),
          fast: slice({ label: "fast", pos: [3, 0], size: N }),
          slow: slice({ label: "slow", pos: [3, 2], size: N }),
        },
        insight: `out1 and out2 are the same channel as in. Whichever reader receives a value first gets it, and the other never sees it, so the two lists split the stream and neither holds all ${N}.`,
        stops: [
          { when: { op: "append", nth: 1 }, say: "One reader got this value. The other reader will never see it." },
          { when: { op: "end" }, say: `The sensor closed in. Each reader's list is missing values, and the test fails.` },
        ],
        tests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@main func Tee(done <-chan struct{}, in <-chan int) (<-chan int, <-chan int) {
@main 	return in, in
@main }`,
        },
        expect: { outcome: "ok", tests: { both: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `One tee goroutine reads in and sends every value to out1 and to out2, so each reader gets all ${N} values, even a slow one.`,
      knobs: [{ key: "slowMs", label: "reader 2 (ms)", options: [0, K.slowMs.value, SLOWER], value: K.slowMs.value }],
      model: goal,
    },
    {
      id: "done",
      chip: "Done",
      tier: "inside",
      summary: `Under TestTeeStopsOnDone, close(done) ends the tee, and it closes out1 and out2 in the same instant. The sensor, which the test owns, is left blocked.`,
      model: {
        nodes: {
          main: goroutine({
            label: "main",
            pos: [4, 1],
            main: true,
            program: function* () {
              yield go("sensor");
              yield go("tee");
              // <-out1; <-out2; <-out1; <-out2
              yield recv("out1");
              yield recv("out2");
              yield recv("out1");
              yield recv("out2");
              yield close("done");
              // assertClosesPromptly reads once from each output.
              const a: { ok: boolean } = yield recv("out1");
              const b: { ok: boolean } = yield recv("out2");
              yield a.ok || b.ok ? fail("stops") : pass("stops");
            },
          }),
          sensor: goroutine({ label: "sensor", pos: [0, 1], spawned: true, program: sensorProgram(K.stopItems.value, false) }),
          in: channel({ label: "in", pos: [1, 1], cap: 0 }),
          tee: goroutine({ label: "tee", pos: [2, 1], spawned: true, program: tee(true, true) }),
          done: channel({ label: "done", pos: [3, 1], cap: 0 }),
          out1: channel({ label: "out1", pos: [3, 0], cap: 0 }),
          out2: channel({ label: "out2", pos: [3, 2], cap: 0 }),
        },
        insight: `The test reads two rounds, then closes done. The tee goroutine is waiting in its outer select, so the done case fires and its deferred closes shut out1 and out2 at once. The sensor still has ${K.stopItems.value - 2} values and now nobody to send to: the red leak line is that test sensor, not Tee, and the test passes.`,
        stops: [
          { when: { op: "close", node: "done" }, say: "The test closes done after two rounds of reads. The tee goroutine is waiting for the next value from in." },
          { when: { op: "close", node: "out1" }, say: "The done case fires, the goroutine returns, and its deferred closes shut both outputs." },
        ],
        tests: stopTests,
        clock: { unit: "ms" },
        code: { file: "solution", text: SOLUTION },
        expect: { outcome: "leak", tests: { stops: "pass" } },
      },
    },
  ],
});
