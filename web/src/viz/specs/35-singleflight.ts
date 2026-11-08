// 35 is about a result that is shared only while its computation is in flight.
// Today every caller runs fn. The solution makes one caller the leader, has the
// others join a per-call WaitGroup, then deletes the entry before returning.
//
// Today, Goal, and Admit model TestDoDedupesConcurrentCallers. Forget models
// TestDoForgetsAfterCompletion, and Error models
// TestDoPropagatesErrorToAllWaiters. Each scene is one test run.
//
// The map is drawn as an entry state because the engine has no map node. It
// tracks the presence of g.m[key]: none, the in-flight call, then gone after
// delete. shareds and errs are the slices the tests actually assert on.

import {
  add,
  defineViz,
  done,
  fact,
  go,
  goroutine,
  inc,
  lock,
  mutex,
  put,
  set,
  slice,
  unlock,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { Program, RunSummary, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  callers: { value: 20, file: "check_test.go", text: "const callers = 20" },
  latency: { value: 150, file: "mockbackend.go", text: "const CallLatency = 150 * time.Millisecond" },
  one: { value: 1, file: "check_test.go", text: "want exactly 1 (the single caller" },
  forgetCalls: { value: 2, file: "check_test.go", text: "cc != 2" },
} as const;

const N = K.callers.value;

const dedupeTests: Record<string, TestDef> = {
  dedupe: {
    name: "TestDoDedupesConcurrentCallers",
    short: "one shared call",
    judge: (run: RunSummary) =>
      run.vars.callCount === K.one.value && run.vars.notShared === K.one.value && run.vars.sharedCount === N - K.one.value,
  },
};

const forgetTests: Record<string, TestDef> = {
  forget: {
    name: "TestDoForgetsAfterCompletion",
    short: "fresh call",
    judge: (run: RunSummary) => run.vars.callCount === K.forgetCalls.value && run.vars.notShared === K.forgetCalls.value,
  },
};

const errorTests: Record<string, TestDef> = {
  error: {
    name: "TestDoPropagatesErrorToAllWaiters",
    short: "same error",
    judge: (run: RunSummary) => run.vars.callCount === K.one.value && run.vars.errCount === N,
  },
};

// The test starts one caller goroutine per index, then waits for all of them.
function testRunner(n: number) {
  return goroutine({
    label: "test",
    pos: [0, 1],
    main: true,
    program: function* () {
      for (let i = 0; i < n; i++) {
        yield add("wg", 1);
        yield go(`caller[${i}]`);
      }
      yield wait("wg");
    },
  });
}

function callerGroup(n: number, program: Program) {
  return goroutine({
    label: "caller",
    pos: [1, 1],
    count: n,
    spawned: true,
    program,
  });
}

const testWG = () => waitgroup({ label: "wg", pos: [1, 2] });
const callWG = () => waitgroup({ label: "c.wg", pos: [2, 2] });
const callCount = () => fact({ label: "Call", pos: [3, 0], value: 0, limit: K.one.value });
const sharedSlice = () => slice({ label: "shareds", pos: [3, 1], size: N });

const SOLUTION_CODE = `
@caller type call struct {
@caller 	wg  sync.WaitGroup
@caller 	v   int
@caller 	err error
@caller }
@caller
@caller type Group struct {
@caller 	mu sync.Mutex
@caller 	m  map[string]*call
@caller }
@caller
@caller func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
@caller 	g.mu.Lock()
@caller 	if g.m == nil {
@caller 		g.m = make(map[string]*call)
@caller 	}
@caller
@caller 	if c, ok := g.m[key]; ok {
@caller 		g.mu.Unlock()
@caller 		c.wg.Wait()
@caller 		return c.v, c.err, true
@caller 	}
@caller
@caller 	c := new(call)
@caller 	c.wg.Add(1)
@caller 	g.m[key] = c
@caller 	g.mu.Unlock()
@caller
@caller 	c.v, c.err = fn()
@caller 	c.wg.Done()
@caller
@caller 	g.mu.Lock()
@caller 	delete(g.m, key)
@caller 	g.mu.Unlock()
@caller
@caller 	return c.v, c.err, false
@caller }`;

// TestDoDedupesConcurrentCallers after the fix. The first caller to see an
// empty entry inserts the call; every later caller finds it and waits.
const admit: Program = function* ({ i, vars }) {
  let leader = false;

  yield lock("mu", { at: "g.mu.Lock()" });
  if ((vars.entry ?? 0) === 0) {
    leader = true;
    vars.entry = 1;
    yield add("callwg", 1, { at: "c.wg.Add(1)" });
    yield set("entry", "call", { at: "g.m[key] = c" });
  }
  yield unlock("mu", { at: "g.mu.Unlock()" });

  if (leader) {
    yield work(K.latency.value, "fn()", { at: "c.v, c.err = fn()" });
    vars.callCount = (vars.callCount ?? 0) + 1;
    yield inc("Call", 1, { at: "c.v, c.err = fn()" });
    yield done("callwg", { at: "c.wg.Done()" });

    yield lock("mu", { at: "g.mu.Lock()" });
    vars.entry = 0;
    yield set("entry", "gone", { at: "delete(g.m, key)" });
    yield unlock("mu", { at: "g.mu.Unlock()" });

    vars.notShared = (vars.notShared ?? 0) + 1;
  } else {
    yield wait("callwg", { at: "c.wg.Wait()" });
    vars.sharedCount = (vars.sharedCount ?? 0) + 1;
  }

  yield done("wg");
};

// TestDoPropagatesErrorToAllWaiters uses the same admission path. The leader
// stores ErrUnavailable in the shared call before releasing the waiters.
const propagateError: Program = function* ({ i, vars }) {
  let leader = false;

  yield lock("mu", { at: "g.mu.Lock()" });
  if ((vars.entry ?? 0) === 0) {
    leader = true;
    vars.entry = 1;
    yield add("callwg", 1, { at: "c.wg.Add(1)" });
    yield set("entry", "call", { at: "g.m[key] = c" });
  }
  yield unlock("mu", { at: "g.mu.Unlock()" });

  if (leader) {
    yield work(K.latency.value, "Call(err-k3)", { at: "c.v, c.err = fn()" });
    vars.callCount = (vars.callCount ?? 0) + 1;
    yield inc("Call", 1, { at: "c.v, c.err = fn()" });
    yield set("ErrUnavailable", "set", { at: "c.v, c.err = fn()" });
    yield done("callwg", { at: "c.wg.Done()" });

    yield lock("mu", { at: "g.mu.Lock()" });
    vars.entry = 0;
    yield set("entry", "gone", { at: "delete(g.m, key)" });
    yield unlock("mu", { at: "g.mu.Unlock()" });
  } else {
    yield wait("callwg", { at: "c.wg.Wait()" });
  }

  vars.errCount = (vars.errCount ?? 0) + 1;
  yield done("wg");
};

export default defineViz({
  schema: 3,
  exercise: "35-singleflight",
  // The first fence draws Today and Goal together, so both pins use it.
  diagrams: { today: "fnv1a:3bae1e08", goal: "fnv1a:3bae1e08" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `All ${N} callers use the same key. Each caller runs fn itself. Call runs ${N} times.`,
      model: {
        nodes: {
          test: testRunner(N),
          wg: testWG(),
          caller: callerGroup(N, function* ({ i, vars }) {
            yield work(K.latency.value, "fn()", { at: "v, err = fn()" });
            vars.callCount = (vars.callCount ?? 0) + 1;
            yield inc("Call", 1, { at: "v, err = fn()" });
            vars.notShared = (vars.notShared ?? 0) + 1;
            yield put("shareds", i, "F", { at: "return v, err, false" });
            yield done("wg");
          }),
          Call: callCount(),
          shareds: sharedSlice(),
        },
        insight: `All ${N} Do calls overlap. There is no in-flight result to join. Each caller runs fn and returns shared=false. Call reaches ${N} instead of ${K.one.value}.`,
        stops: [
          { when: { op: "work", g: "caller", nth: N }, say: `All ${N} callers run fn at once. No caller waits for another result.` },
          { when: { op: "end" }, say: `Every shareds entry is F and Call reaches ${N}. The test wants one F and one Call.` },
        ],
        tests: dedupeTests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@caller func (g *Group) Do(key string, fn func() (int, error)) (v int, err error, shared bool) {
@caller 	v, err = fn()
@caller 	return v, err, false
@caller }`,
        },
        expect: { outcome: "ok", t: K.latency.value, tests: { dedupe: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `One caller runs fn. The other ${N - K.one.value} wait. Everyone then gets the same result with the correct shared flag.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }) {
              yield work(K.latency.value, "fn()", { at: "fn func()" });
              vars.callCount = K.one.value;
              vars.notShared = K.one.value;
              vars.sharedCount = N - K.one.value;
              yield inc("Call", 1);
              yield set("wait", 0);
              yield set("shared", "1F 19T");
            },
          }),
          wait: fact({ label: "wait", pos: [1, 0], value: N - K.one.value, unit: "callers" }),
          Call: callCount(),
          shared: fact({ label: "shared", pos: [1, 1], value: "pending" }),
        },
        insight: `One caller runs fn. The other ${N - K.one.value} wait. When the result is ready, all ${N} return. One reports shared=false and ${N - K.one.value} report shared=true.`,
        stops: [
          { when: { op: "work", g: "caller", nth: K.one.value }, say: "One caller runs fn. Every duplicate waits instead of starting another backend call." },
          { when: { op: "set", node: "wait" }, say: `The result releases all ${N - K.one.value} waiters together. They share the same value and error.` },
          { when: { op: "set", node: "shared" }, say: "The leader gets shared=false. The joiners get shared=true." },
        ],
        tests: dedupeTests,
        clock: { unit: "ms" },
        expect: {
          outcome: "ok",
          t: K.latency.value,
          tests: { dedupe: "pass" },
        },
      },
    },
    {
      id: "admit",
      chip: "Admit",
      tier: "inside",
      summary: `The mutex lets one caller insert g.m[key]. That caller runs fn while every joiner waits on c.wg.`,
      model: {
        nodes: {
          test: testRunner(N),
          wg: testWG(),
          caller: callerGroup(N, admit),
          mu: mutex({ label: "g.mu", pos: [2, 0] }),
          entry: fact({ label: "entry", pos: [2, 1], value: "none", states: ["none", "call", "gone"] }),
          callwg: callWG(),
          Call: callCount(),
        },
        insight: `The leader inserts one call and unlocks before fn runs. Joiners find the entry and wait on its WaitGroup. They return shared=true. Only the leader returns shared=false.`,
        stops: [
          { when: { op: "set", node: "entry" }, say: "The first caller inserts the in-flight call. It owns the single fn call and releases g.mu." },
          { when: { op: "block", g: "caller" }, say: "Duplicate callers find the entry. They block on c.wg instead of entering fn." },
          { when: { op: "done", node: "callwg" }, say: "The leader publishes the result. It then deletes the entry before returning." },
        ],
        tests: dedupeTests,
        clock: { unit: "ms" },
        code: { file: "solution", text: SOLUTION_CODE },
        expect: { outcome: "ok", t: K.latency.value, tests: { dedupe: "pass" } },
      },
    },
    {
      id: "forget",
      chip: "Forget",
      tier: "inside",
      summary: `Two sequential Do calls use the same key. Each one creates a new entry. The first deletes it, so the second runs fn again.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }) {
              for (let n = 0; n < K.forgetCalls.value; n++) {
                yield lock("mu", { at: "g.mu.Lock()" });
                vars.entry = 1;
                yield add("callwg", 1, { at: "c.wg.Add(1)" });
                yield set("entry", "call", { at: "g.m[key] = c" });
                yield unlock("mu", { at: "g.mu.Unlock()" });

                yield work(K.latency.value, "fn()", { at: "c.v, c.err = fn()" });
                vars.callCount = (vars.callCount ?? 0) + 1;
                yield inc("Call", 1, { at: "c.v, c.err = fn()" });
                yield done("callwg", { at: "c.wg.Done()" });

                yield lock("mu", { at: "g.mu.Lock()" });
                vars.entry = 0;
                yield set("entry", "gone", { at: "delete(g.m, key)" });
                yield unlock("mu", { at: "g.mu.Unlock()" });

                vars.notShared = (vars.notShared ?? 0) + 1;
                yield set("shared", "false", { at: "return c.v, c.err, false" });
              }
            },
          }),
          mu: mutex({ label: "g.mu", pos: [1, 0] }),
          entry: fact({ label: "entry", pos: [1, 1], value: "none", states: ["none", "call", "gone"] }),
          callwg: callWG(),
          Call: fact({ label: "Call", pos: [2, 0], value: 0 }),
          shared: fact({ label: "shared", pos: [2, 1], value: "false", states: ["true", "false"] }),
        },
        insight: `The code deletes the entry before return. Sharing lasts only while a call is in flight. The second Do is sequential, finds no entry, and starts a new ${K.latency.value} ms call.`,
        stops: [
          { when: { op: "set", node: "entry", nth: 2 }, say: "The first call finishes and deletes its entry. No result is cached." },
          { when: { op: "work", g: "caller" }, say: "The next Do starts as a new leader. Call runs again and shared is false again." },
        ],
        tests: forgetTests,
        clock: { unit: "ms" },
        code: { file: "solution", text: SOLUTION_CODE },
        expect: {
          outcome: "ok",
          t: K.latency.value * K.forgetCalls.value,
          tests: { forget: "pass" },
        },
      },
    },
    {
      id: "error",
      chip: "Error",
      tier: "inside",
      summary: `One leader's Call(err-k3) returns ErrUnavailable. Joiners wait for the same call and return the same error.`,
      model: {
        nodes: {
          test: testRunner(N),
          wg: testWG(),
          caller: callerGroup(N, propagateError),
          mu: mutex({ label: "g.mu", pos: [2, 0] }),
          entry: fact({ label: "entry", pos: [2, 1], value: "none", states: ["none", "call", "gone"] }),
          callwg: callWG(),
          ErrUnavailable: fact({ label: "ErrUnavailable", pos: [3, 0], value: "nil", states: ["nil", "set"] }),
          Call: fact({ label: "Call", pos: [3, 1], value: 0, limit: K.one.value }),
        },
        insight: `The leader stores the error beside the value in the same call. It then releases c.wg. All ${N} callers return ErrUnavailable. Call still runs once.`,
        stops: [
          { when: { op: "set", node: "ErrUnavailable" }, say: "The failed fn returns through the same result field. Success and error use one path." },
          { when: { op: "done", node: "wg", nth: N }, say: `All ${N} callers now carry the shared error; Call stayed at ${K.one.value}.` },
        ],
        tests: errorTests,
        clock: { unit: "ms" },
        code: { file: "solution", text: SOLUTION_CODE },
        expect: { outcome: "ok", t: K.latency.value, tests: { error: "pass" } },
      },
    },
  ],
});
