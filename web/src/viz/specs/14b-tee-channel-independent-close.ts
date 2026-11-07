// 14b separates delivery from closing. The scaffold holds value N until
// both outputs receive it, so a fast output cannot close while the other is
// unread. The goal satisfies the same contract with independent FIFO lanes.
// The Queue and Next scenes expose the solution's actual sync.Cond queue.

import {
  append,
  channel,
  close,
  cond,
  condBroadcast,
  condSignal,
  condWait,
  defineViz,
  fact,
  fail,
  go,
  goroutine,
  lock,
  mutex,
  onRecv,
  onSend,
  range,
  recv,
  select,
  send,
  set,
  shift,
  slice,
  sleep,
  start,
  stop,
  timer,
  unlock,
} from "../engine/ops.ts";
import type { Model, Op, RecvResult, SelectResult, TestDef } from "../engine/model.ts";

const K = {
  values: { value: 5, file: "check_test.go", text: "const n = 5" },
  interval: { value: 5, file: "mocksensor.go", text: "const SensorInterval = 5 * time.Millisecond" },
} as const;

const N = K.values.value;
const BUDGET = 4 * K.interval.value;

const tests: Record<string, TestDef> = {
  closes: {
    name: "TestTeeClosesEachOutputAsSoonAsItIsFullyDelivered",
    short: "closes fast",
    judge: (run) => run.vars.fast === N && run.vars.slow === N && run.vars.fastClosed === 1 && run.vars.slowClosed === 1,
  },
};

function* readN(vars: Record<string, number>, out: string, key: "fast" | "slow"): Generator<Op, boolean, unknown> {
  for (;;) {
    const n = vars[key] ?? 0;
    if (n >= N) break;
    yield start("budget");
    const result = (yield select([onRecv(out), onRecv("budget")])) as SelectResult;
    if (result.i === 1) {
      yield fail("closes");
      yield close("done");
      return false;
    }
    if (!result.ok) {
      yield fail("closes");
      yield close("done");
      return false;
    }
    yield stop("budget");
    vars[key] = n + 1;
  }
  const end = (yield recv(out)) as RecvResult;
  if (end.ok) {
    yield fail("closes");
    yield close("done");
    return false;
  }
  vars[`${key}Closed`] = 1;
  return true;
}

function sensor(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "sensor",
    pos: [0, 1],
    spawned: true,
    program: function* () {
      for (let i = 0; i < N; i++) {
        yield sleep(K.interval.value);
        const r: SelectResult = yield select([onSend("in", i), onRecv("done")]);
        if (r.i === 1) return;
      }
      yield close("in");
    },
  });
}

function today(): Model {
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 0],
        main: true,
        program: function* ({ vars }) {
          yield go("sensor");
          yield go("tee");
          if (!(yield* readN(vars, "out1", "fast"))) return;
          if (!(yield* readN(vars, "out2", "slow"))) return;
        },
      }),
      sensor: sensor(),
      in: channel({ label: "in", pos: [1, 1], cap: 0 }),
      done: channel({ label: "done", pos: [1, 3], cap: 0 }),
      budget: timer({ label: "budget", pos: [0, 2], after: BUDGET }),
      tee: goroutine({
        label: "tee",
        pos: [2, 0],
        spawned: true,
        program: function* () {
          for (;;) {
            const r: SelectResult = yield select([onRecv("in"), onRecv("done")]);
            if (r.i === 1) break;
            if (!r.ok) break;
            let waiting = [0, 1];
            while (waiting.length > 0) {
              const cases = waiting.map((i) => onSend(i === 0 ? "out1" : "out2", r.v));
              cases.push(onRecv("done"));
              const result: SelectResult = yield select(cases, { at: "select {" });
              if (result.i === waiting.length) break;
              const sent = waiting[result.i]!;
              waiting = waiting.filter((i) => i !== sent);
            }
            if (waiting.length > 0) break;
          }
          yield close("out1");
          yield close("out2");
        },
      }),
      out1: channel({ label: "out1", pos: [3, 0], cap: 0 }),
      out2: channel({ label: "out2", pos: [3, 2], cap: 0 }),
    },
    insight:
      "The test reads out1. After out1 takes one value, tee is blocked trying to hand the same value to untouched out2, so it cannot read the next sensor value and out1 never closes.",
    stops: [
      { when: { op: "select", g: "tee" }, say: "out1 receives a value, but tee still owes it to out2." },
      { when: { op: "block", g: "tee" }, say: "out2 is never read. tee waits there and abandons the rest of the stream." },
    ],
    tests,
    clock: { unit: "ms", budget: { at: BUDGET, label: "receive budget" } },
    expect: { outcome: "ok", t: N * K.interval.value, tests: { closes: "fail" } },
    code: {
      file: "main.go",
      text: `
@tee 	for {
@tee 		select {
@tee 		case <-done:
@tee 			return
@tee 		case v, ok = <-in:
@tee 			if !ok {
@tee 				return
@tee 			}
@tee 		}
@tee
@tee 		out1Ch, out2Ch := out1, out2
@tee 		for out1Ch != nil || out2Ch != nil {
@tee 			select {
@tee 			case out1Ch <- v:
@tee 				out1Ch = nil
@tee 			case out2Ch <- v:
@tee 				out2Ch = nil
@tee 			case <-done:
@tee 				return
@tee 			}
@tee 		}
@tee 	}`,
    },
  };
}

function independent(fastIndex: number): Model {
  const fast = fastIndex === 0 ? "out1" : "out2";
  const slow = fastIndex === 0 ? "out2" : "out1";
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 0],
        main: true,
        program: function* ({ vars }) {
          yield go("sensor");
          yield go("tee");
          if (!(yield* readN(vars, fast, "fast"))) return;
          if (!(yield* readN(vars, slow, "slow"))) return;
        },
      }),
      sensor: sensor(),
      in: channel({ label: "in", pos: [1, 1], cap: 0 }),
      done: channel({ label: "done", pos: [1, 3], cap: 0 }),
      budget: timer({ label: "budget", pos: [0, 2], after: BUDGET }),
      tee: goroutine({
        label: "tee",
        pos: [2, 0],
        spawned: true,
        program: function* () {
          for (;;) {
            const r: SelectResult = yield select([onRecv("in"), onRecv("done")]);
            if (r.i === 1) break;
            if (!r.ok) break;
            yield send("out1", r.v);
            yield send("out2", r.v);
          }
          yield close("out1");
          yield close("out2");
        },
      }),
      out1: channel({ label: "out1", pos: [3, 0], cap: N }),
      out2: channel({ label: "out2", pos: [3, 2], cap: N }),
    },
    insight: `Each output has enough independent buffering for the bounded sensor stream. ${fast} receives and closes without ${slow} being read; only then does the test drain ${slow}.`,
    stops: [
      { when: { op: "close", node: fast }, say: `${fast} has every value and closes without waiting for ${slow}.` },
      { when: { op: "recv", node: slow }, say: `Only after ${fast} is closed and verified does the test start reading ${slow}.` },
    ],
    tests,
    clock: { unit: "ms", budget: { at: BUDGET, label: "receive budget" } },
    expect: { outcome: "ok", t: N * K.interval.value, tests: { closes: "pass" } },
  };
}

function queueScene(): Model {
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 0],
        main: true,
        program: function* ({ vars }) {
          yield go("pusher");
          yield go("forward");
          yield* range("out", function* () {
            vars.got = (vars.got ?? 0) + 1;
          });
        },
      }),
      pusher: goroutine({
        label: "pusher",
        pos: [1, 0],
        spawned: true,
        program: function* ({ vars }) {
          for (let i = 0; i < N; i++) {
            yield sleep(K.interval.value);
            yield lock("qmu");
            yield append("values", i, { at: "q.values = append(q.values, value)" });
            vars.qlen = (vars.qlen ?? 0) + 1;
            yield condSignal("ready", { at: "q.cond.Signal()" });
            yield unlock("qmu");
          }
          yield lock("qmu");
          vars.qclosed = 1;
          yield set("closed", true);
          yield condBroadcast("ready", { at: "q.cond.Broadcast()" });
          yield unlock("qmu");
        },
      }),
      forward: goroutine({
        label: "forward",
        pos: [2, 1],
        spawned: true,
        program: function* ({ vars }) {
          for (;;) {
            yield lock("qmu", { at: "q.mu.Lock()" });
            while ((vars.qlen ?? 0) === 0 && vars.qclosed !== 1) {
              yield condWait("ready", { at: "q.cond.Wait()" });
            }
            if ((vars.qlen ?? 0) === 0) {
              yield unlock("qmu", { at: "q.mu.Unlock()" });
              yield close("out");
              return;
            }
            const r: RecvResult = yield shift("values", { at: "q.values = q.values[1:]" });
            vars.qlen = (vars.qlen ?? 0) - 1;
            yield unlock("qmu", { at: "q.mu.Unlock()" });
            yield send("out", r.tok!, { at: "out <- value" });
          }
        },
      }),
      qmu: mutex({ label: "qmu", pos: [1, 1] }),
      ready: cond({ label: "ready", pos: [1, 2], mu: "qmu" }),
      values: slice({ label: "values", pos: [2, 0], size: N }),
      closed: fact({ label: "closed", pos: [3, 2], value: false }),
      out: channel({ label: "out", pos: [3, 1], cap: 0 }),
    },
    insight:
      "pusher appends under qmu and signals ready. forward waits on ready, then shifts the FIFO head before unlocking. After the last push, Broadcast wakes it so an empty closed queue makes next return false and out close.",
    stops: [
      { when: { op: "condWait" }, say: "forward releases qmu and waits until pusher appends a value." },
      { when: { op: "condSignal" }, say: "After appending, pusher signals one waiter. The woken forwarder must reacquire qmu before next returns." },
      { when: { op: "condBroadcast" }, say: "Closing the queue broadcasts to every waiter so the forwarder can observe the closed state." },
    ],
    clock: { unit: "ms" },
    expect: { outcome: "ok", t: N * K.interval.value },
    code: {
      file: "solution",
      text: `
@pusher func (q *outputQueue) push(value int) {
@pusher 	q.mu.Lock()
@pusher 	q.values = append(q.values, value)
@pusher 	q.cond.Signal()
@pusher 	q.mu.Unlock()
@pusher }
@pusher
@pusher func (q *outputQueue) close() {
@pusher 	q.mu.Lock()
@pusher 	q.closed = true
@pusher 	q.cond.Broadcast()
@pusher 	q.mu.Unlock()
@pusher }
@pusher
@forward func (q *outputQueue) next() (int, bool) {
@forward 	q.mu.Lock()
@forward 	defer q.mu.Unlock()
@forward 	for len(q.values) == 0 && !q.closed {
@forward 		q.cond.Wait()
@forward 	}
@forward 	if len(q.values) == 0 {
@forward 		return 0, false
@forward 	}
@forward 	value := q.values[0]
@forward 	q.values[0] = 0
@forward 	q.values = q.values[1:]
@forward 	return value, true
@forward }
@forward
@forward func forwardOutput(done <-chan struct{}, out chan<- int, q *outputQueue) {
@forward 	defer close(out)
@forward 	for {
@forward 		value, ok := q.next()
@forward 		if !ok {
@forward 			return
@forward 		}
@forward 		select {
@forward 		case out <- value:
@forward 		case <-done:
@forward 			return
@forward 		}
@forward 	}
@forward }`,
    },
  };
}

export default defineViz({
  schema: 3,
  exercise: "14b-tee-channel-independent-close",
  diagrams: { today: "fnv1a:56addd3c", goal: "fnv1a:56addd3c" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `out1 receives a value, but tee is parked on untouched out2 and cannot read the next sensor value; the ${BUDGET} ms receive budget expires.`,
      model: today(),
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "Each output has independent delivery and completion tracking, so the fast output closes before the slow output is read.",
      knobs: [{ key: "fastIndex", label: "fast output", options: [0, 1], value: 0 }],
      model: (P) => independent(Number(P.fastIndex)),
    },
    {
      id: "queue",
      chip: "Queue",
      tier: "inside",
      summary: "The worked solution stores each output's values in a FIFO guarded by sync.Cond and removes the head with next.",
      model: queueScene(),
    },
  ],
});
