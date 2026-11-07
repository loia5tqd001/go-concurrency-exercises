// 36 has two independent ideas: one batch may be fired by its count, its
// deadline, or Close, and each caller must still receive the response for its
// own position. Today runs fn once per request. Goal shows only the observable
// contract, without choosing an internal ownership design. Inside scenes
// isolate the deadline, rollover, and context-bounded shutdown paths.
//
// The engine cannot conditionally create a time.AfterFunc callback. In the
// wait scene the callback exists only because the timer actually fires. In
// the rollover scene a count fire stops the current timer before it can run.
// That scene is visibly labelled Stop: it does not exercise Stop returning
// false after a callback has already started. The single timer node stands for
// the current batch's own timer, and the code excerpt carries the per-batch
// c.batch == b guard.

import {
  add,
  append,
  channel,
  close,
  defineViz,
  done,
  fact,
  go,
  goroutine,
  inc,
  lock,
  mutex,
  onRecv,
  put,
  recv,
  select,
  send,
  set,
  SIGNAL,
  slice,
  start,
  stop,
  timer,
  unlock,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { Program, RunSummary, TestDef } from "../engine/model.ts";

const K = {
  fullBatch: { value: 5, file: "check_test.go", text: "Config{MaxBatchSize: 5, MaxWait: time.Hour}" },
  partialMax: { value: 100, file: "check_test.go", text: "Config{MaxBatchSize: 100, MaxWait: 50 * time.Millisecond}" },
  waitMs: { value: 50, file: "check_test.go", text: "MaxWait: 50 * time.Millisecond" },
  request0: { value: 10, file: "check_test.go", text: "ch0 := c.Add(10)" },
  request1: { value: 20, file: "check_test.go", text: "ch1 := c.Add(20)" },
  rollSize: { value: 4, file: "check_test.go", text: "const batchSize = 4" },
  rollBatches: { value: 3, file: "check_test.go", text: "const batches = 3" },
  closeBatch: { value: 2, file: "check_test.go", text: "Config{MaxBatchSize: 2, MaxWait: time.Hour}" },
  closeDeadline: { value: 50, file: "check_test.go", text: "context.WithTimeout(context.Background(), 50*time.Millisecond)" },
  recvTimeoutS: { value: 2, file: "check_test.go", text: "const recvTimeout = 2 * time.Second" },
} as const;

const FULL = K.fullBatch.value;
const ROLL_SIZE = K.rollSize.value;
const ROLL_BATCHES = K.rollBatches.value;
const CLOSE_BATCH = K.closeBatch.value;
const HOUR_MS = 60 * 60 * 1000; // time.Hour in the rollover test.
const ROLL_RESULTS = Array.from({ length: ROLL_SIZE * ROLL_BATCHES }, (_, i) => {
  const wave = Math.floor(i / ROLL_SIZE);
  return (wave * 100 + (i % ROLL_SIZE)) * 2;
});
const FULL_RESPONSES = Array.from({ length: FULL }, (_, i) => i * 2);

const tests: Record<string, TestDef> = {
  full: {
    name: "TestCollectorFiresOnMaxBatchSize",
    short: "full batch",
    judge: (run: RunSummary) => {
      const responses = (run.world.slice.responses ?? []).map((id) => (id === null ? null : run.world.tokens[id]?.v));
      return run.vars.callCount === 1 && FULL_RESPONSES.every((want, i) => responses[i] === want);
    },
  },
  wait: {
    name: "TestCollectorFiresOnMaxWaitWithPartialBatch",
    short: "wait timer",
    judge: (run: RunSummary) =>
      run.vars.callCount === 1 &&
      run.vars.got0 === K.request0.value * 2 &&
      run.vars.got1 === K.request1.value * 2,
  },
  roll: {
    name: "TestCollectorRollsOverToNewBatchAfterFiring",
    short: "three batches",
    judge: (run: RunSummary) => {
      const results = (run.world.slice.results ?? []).map((id) => (id === null ? null : run.world.tokens[id]?.v));
      return run.vars.callCount === ROLL_BATCHES && ROLL_RESULTS.every((want, i) => results[i] === want);
    },
  },
  close: {
    name: "TestCollectorCloseRespectsContextDeadline",
    short: "close timeout",
    judge: (run: RunSummary) =>
      run.vars.callCount === 1 &&
      run.vars.timedOut === 1 &&
      run.vars.got0 === 2 &&
      run.vars.got1 === 4,
  },
};

const solutionOpen = (owner: "add" | "test") => `
@${owner} func (c *Collector) Add(request int) <-chan Result {
@${owner} \tch := make(chan Result, 1)

@${owner} \tc.mu.Lock()

@${owner} \tif c.closed {
@${owner} \t\tc.mu.Unlock()
@${owner} \t\tch <- Result{Err: ErrCollectorClosed}
@${owner} \t\treturn ch
@${owner} \t}

@${owner} \tb := c.openBatch()
@${owner} \tb.requests = append(b.requests, request)
@${owner} \tb.resultChs = append(b.resultChs, ch)

@${owner} \tvar fire bool
@${owner} \tif len(b.requests) >= c.cfg.MaxBatchSize {
@${owner} \t\tfire = c.detach(b)
@${owner} \t}
@${owner} \tc.mu.Unlock()

@${owner} \tif fire {
@${owner} \t\tc.startExecute(b)
@${owner} \t}
@${owner} \treturn ch
@${owner} }

@test // openBatch returns the batch new requests should join, opening a
@test // fresh one (and arming its deadline timer, if configured) if none is
@test // currently open. Must be called with c.mu held.
@test func (c *Collector) openBatch() *batch {
@test \tif c.batch != nil {
@test \t\treturn c.batch
@test \t}
@test \tb := &batch{}
@test \tc.batch = b
@test \tif c.cfg.MaxWait > 0 {
@test \t\tb.timer = time.AfterFunc(c.cfg.MaxWait, func() { c.onDeadline(b) })
@test \t}
@test \treturn b
@test }`;

const solutionDetach = (owner: "deadline" | "test") => `
@${owner} // detach marks b as fired - idempotent, only the first caller (from
@${owner} // whichever trigger: count reached, deadline, or Close) ever gets
@${owner} // true back - and detaches it from c.batch if it's still current.
@${owner} // Must be called with c.mu held.
@${owner} func (c *Collector) detach(b *batch) bool {
@${owner} \tif b.fired {
@${owner} \t\treturn false
@${owner} \t}
@${owner} \tb.fired = true
@${owner} \tif b.timer != nil {
@${owner} \t\tb.timer.Stop()
@${owner} \t}
@${owner} \tif c.batch == b {
@${owner} \t\tc.batch = nil
@${owner} \t}
@${owner} \tc.inflight.Add(1)
@${owner} \treturn true
@${owner} }

@${owner} func (c *Collector) onDeadline(b *batch) {
@${owner} \tc.mu.Lock()
@${owner} \tfire := c.detach(b)
@${owner} \tc.mu.Unlock()

@${owner} \tif fire {
@${owner} \t\tc.startExecute(b)
@${owner} \t}
@${owner} }`;

const solutionExecute = (owner: "execute" | "test") => `
@${owner} func (c *Collector) startExecute(b *batch) {
@${owner} \tgo func() {
@${owner} \t\tdefer c.inflight.Done()
@${owner} \t\tc.executeBatch(b)
@${owner} \t}()
@${owner} }

@${owner} func (c *Collector) executeBatch(b *batch) {
@${owner} \tresponses, err := c.fn(b.requests)
@${owner} \tfor i, resultCh := range b.resultChs {
@${owner} \t\tif err != nil {
@${owner} \t\t\tresultCh <- Result{Err: err}
@${owner} \t\t\tcontinue
@${owner} \t\t}
@${owner} \t\tresultCh <- Result{Value: responses[i]}
@${owner} \t}
@${owner} }`;

const SOLUTION_CLOSE = `
@test func (c *Collector) Close(ctx context.Context) error {
@test \tc.mu.Lock()
@test \tc.closed = true
@test \tb := c.batch
@test \tvar fire bool
@test \tif b != nil {
@test \t\tfire = c.detach(b)
@test \t}
@test \tc.mu.Unlock()

@test \tif fire {
@test \t\tc.startExecute(b)
@test \t}

@test \tdone := make(chan struct{})
@waiter \tgo func() {
@waiter \t\tc.inflight.Wait()
@waiter \t\tclose(done)
@waiter \t}()

@test \tselect {
@test \tcase <-done:
@test \t\treturn nil
@test \tcase <-ctx.Done():
@test \t\treturn ctx.Err()
@test \t}
@test }`;

function callerProgram(program: Program) {
  return goroutine({
    label: "caller",
    pos: [1, 1],
    count: FULL,
    spawned: true,
    program,
  });
}

function waveCaller(execute: "execA" | "execB" | "execC", pos: readonly [number, number]) {
  return goroutine({
    label: `callers ${execute.slice(-1)}`,
    pos,
    count: ROLL_SIZE,
    spawned: true,
    program: function* ({ vars }: { vars: Record<string, number> }) {
      yield lock("mu", { at: "c.mu.Lock()" });
      if ((vars.requests ?? 0) === 0) {
        yield start("MaxWait", { at: "time.AfterFunc(" });
      }
      vars.requests = (vars.requests ?? 0) + 1;
      yield inc("requests", 1, { at: "append(b.requests, request)" });

      let fire = false;
      if (vars.requests >= ROLL_SIZE) {
        vars.requests = 0;
        yield set("requests", 0, { at: "c.batch = nil" });
        yield stop("MaxWait", { at: "b.timer.Stop()" });
        fire = true;
      }
      yield unlock("mu", { at: "c.mu.Unlock()" });

      if (fire) {
        yield go(execute, { at: "c.startExecute(b)" });
      }
      yield recv("ready");
      yield done("waveWG");
    },
  });
}

function executeWave(wave: number, pos: readonly [number, number]) {
  const base = wave * 100;
  return goroutine({
    label: `exec ${String.fromCharCode(65 + wave)}`,
    pos,
    spawned: true,
    program: function* ({ vars }: { vars: Record<string, number> }) {
      yield work(0, "doubleFn", { at: "responses, err := c.fn" });
      vars.callCount = (vars.callCount ?? 0) + 1;
      yield inc("Call", 1, { at: "responses, err := c.fn" });
      for (let i = 0; i < ROLL_SIZE; i++) {
        yield put("results", wave * ROLL_SIZE + i, (base + i) * 2, { at: "resultCh <- Result{Value:" });
      }
      for (let i = 0; i < ROLL_SIZE; i++) {
        yield send("ready", SIGNAL);
      }
    },
  });
}

export default defineViz({
  schema: 3,
  exercise: "36-batch-collector",
  // The first fence is the Today/Goal door. The second is the trigger-race
  // trap, which the Inside scenes use as source material.
  diagrams: { today: "fnv1a:a7be099a", goal: "fnv1a:a7be099a" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `All ${FULL} callers run doubleFn themselves. Scaffold Add calls fn at once with only its own request.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* () {
              yield add("wg", FULL);
              yield go("caller[*]");
              yield wait("wg");
            },
          }),
          wg: waitgroup({ label: "wg", pos: [0, 2] }),
          caller: callerProgram(function* ({ vars }: { vars: Record<string, number> }) {
            yield work(0, "doubleFn", { at: "responses, err := c.fn" });
            vars.callCount = (vars.callCount ?? 0) + 1;
            yield inc("Call", 1, { at: "responses, err := c.fn" });
            yield done("wg");
          }),
          Call: fact({ label: "Call", pos: [2, 1], value: 0, limit: 1 }),
        },
        insight: `Every Add skips batching. Call reaches ${FULL} for ${FULL} requests. No caller shares a round-trip with another.`,
        stops: [
          {
            when: { op: "work", g: "caller", nth: FULL },
            say: `All ${FULL} callers are inside their own fn call. There is no batch to join.`,
          },
          {
            when: { op: "end" },
            say: `Call is ${FULL}, but the test wants 1. The scaffold has no MaxWait or Close path for batching.`,
          },
        ],
        tests: { full: tests.full! },
        code: {
          file: "main.go",
          text: `
@caller func (c *Collector) Add(request int) <-chan Result {
@caller \tch := make(chan Result, 1)
@caller
@caller \tresponses, err := c.fn([]int{request})
@caller \tif err != nil {
@caller \t\tch <- Result{Err: err}
@caller \t} else {
@caller \t\tch <- Result{Value: responses[0]}
@caller \t}
@caller
@caller \treturn ch
@caller }
…
@test func (c *Collector) Close(ctx context.Context) error {
@test \treturn nil
@test }`,
        },
        expect: { outcome: "ok", tests: { full: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `${FULL} callers submit into one batch. fn runs once. Every caller receives the response for its own request.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 2],
            main: true,
            program: function* () {
              yield add("delivered", FULL);
              yield add("wg", FULL);
              yield add("submitted", FULL);
              yield go("caller[*]");
              yield wait("submitted");
              yield go("fn");
              yield wait("wg");
            },
          }),
          submitted: waitgroup({ label: "submitted", pos: [0, 0] }),
          delivered: waitgroup({ label: "done", pos: [1, 4] }),
          wg: waitgroup({ label: "wg", pos: [3, 4] }),
          caller: callerProgram(function* ({ i }: { i: number }) {
            yield put("batch", i, i);
            yield done("submitted");
            yield wait("delivered");
            yield done("wg");
          }),
          batch: slice({ label: "batch", pos: [2, 2], size: FULL }),
          fn: goroutine({
            label: "fn",
            pos: [3, 2],
            spawned: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield wait("submitted");
              yield work(0, "fn(batch)");
              vars.callCount = (vars.callCount ?? 0) + 1;
              yield inc("Call", 1);
              for (let request = 0; request < FULL; request++) {
                yield put("responses", request, request * 2);
                yield done("delivered");
              }
            },
          }),
          responses: slice({ label: "responses", pos: [4, 2], size: FULL }),
          Call: fact({ label: "Call", pos: [4, 1], value: 0, limit: 1 }),
        },
        insight: `All ${FULL} requests enter one batch. fn runs once after every caller submits. It writes one response per request position. It then releases all callers.`,
        stops: [
          {
            when: { op: "work", g: "fn" },
            say: "The batch is full. One fn call sees all five submitted requests.",
          },
          {
            when: { op: "put", g: "fn", nth: FULL },
            say: `All ${FULL} ordered responses are ready. Call stays at 1.`,
          },
        ],
        tests: { full: tests.full! },
        expect: { outcome: "ok", tests: { full: "pass" } },
      },
    },
    {
      id: "waited",
      chip: "Wait",
      tier: "inside",
      summary: `Two requests do not reach MaxBatchSize. The ${K.waitMs.value} ms timer fires one partial batch and delivers both responses.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 2],
            main: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield lock("mu", { at: "c.mu.Lock()" });
              yield set("batch", "batch", { at: "c.batch = b" });
              yield start("MaxWait", { at: "time.AfterFunc(" });
              yield go("deadline", { at: "time.AfterFunc(" });
              yield append("requests", K.request0.value, { at: "append(b.requests, request)" });
              yield unlock("mu", { at: "c.mu.Unlock()" });

              yield lock("mu", { at: "c.mu.Lock()" });
              yield append("requests", K.request1.value, { at: "append(b.requests, request)" });
              yield unlock("mu", { at: "c.mu.Unlock()" });

              const r0 = yield recv("result0");
              const r1 = yield recv("result1");
              vars.got0 = Number(r0.v);
              vars.got1 = Number(r1.v);
            },
          }),
          mu: mutex({ label: "mu", pos: [1, 1] }),
          batch: fact({ label: "c.batch", pos: [1, 0], value: "nil", states: ["nil", "batch"] }),
          fired: fact({ label: "b.fired", pos: [1, 2], value: "no", states: ["no", "yes"] }),
          MaxWait: timer({ label: "MaxWait", pos: [2, 0], after: K.waitMs.value }),
          deadline: goroutine({
            label: "deadline",
            pos: [2, 1],
            spawned: true,
            program: function* () {
              yield recv("MaxWait", { at: "func() { c.onDeadline(b) }" });
              yield stop("MaxWait", { at: "b.timer.Stop()" });
              yield lock("mu", { at: "c.mu.Lock()" });
              yield set("fired", "yes", { at: "b.fired = true" });
              yield set("batch", "nil", { at: "c.batch = nil" });
              yield unlock("mu", { at: "c.mu.Unlock()" });
              yield go("execute", { at: "c.startExecute(b)" });
            },
          }),
          requests: slice({ label: "requests", pos: [2, 2], size: 2 }),
          execute: goroutine({
            label: "execute",
            pos: [3, 1],
            spawned: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield work(0, "doubleFn", { at: "responses, err := c.fn" });
              vars.callCount = (vars.callCount ?? 0) + 1;
              yield inc("Call", 1, { at: "responses, err := c.fn" });
              yield send("result0", K.request0.value * 2, { at: "resultCh <- Result{Value:" });
              yield send("result1", K.request1.value * 2, { at: "resultCh <- Result{Value:" });
            },
          }),
          result0: channel({ label: "result 0", pos: [3, 2], cap: 1 }),
          result1: channel({ label: "result 1", pos: [4, 2], cap: 1 }),
          Call: fact({ label: "Call", pos: [4, 1], value: 0, limit: 1 }),
        },
        insight: `The second Add joins the open batch. The count stays below ${K.partialMax.value}. At ${K.waitMs.value} ms the deadline removes that same batch from c.batch once. One fn call returns 20 and 40.`,
        stops: [
          {
            when: { op: "go", g: "test", node: "deadline" },
            say: `The first Add starts this batch's ${K.waitMs.value} ms timer before releasing mu.`,
          },
          {
            when: { op: "fire", node: "MaxWait" },
            say: "The partial batch still fires. The deadline and count paths remove the batch in the same place.",
          },
          {
            when: { op: "send", g: "execute", node: "result1" },
            say: "Both callers receive the response for their own request index in the batch.",
          },
        ],
        tests: { wait: tests.wait! },
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `${solutionOpen("test")}\n…\n${solutionDetach("deadline")}\n…\n${solutionExecute("execute")}`,
        },
        expect: { outcome: "ok", t: K.waitMs.value, tests: { wait: "pass" } },
      },
    },
    {
      id: "roll",
      chip: "Stop",
      tier: "inside",
      summary:
        "Each count trigger stops MaxWait before it runs. This scene does not test a callback already running or Stop returning false.",
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 2],
            main: true,
            program: function* () {
              const callers = ["callerA", "callerB", "callerC"] as const;
              for (const caller of callers) {
                yield add("waveWG", ROLL_SIZE);
                yield go(`${caller}[*]`);
                yield wait("waveWG");
              }
            },
          }),
          waveWG: waitgroup({ label: "waveWG", pos: [0, 3] }),
          callerA: waveCaller("execA", [1, 0]),
          callerB: waveCaller("execB", [1, 1]),
          callerC: waveCaller("execC", [1, 2]),
          mu: mutex({ label: "mu", pos: [2, 1] }),
          requests: fact({ label: "requests", pos: [3, 1], value: 0, limit: ROLL_SIZE }),
          MaxWait: timer({ label: "MaxWait", pos: [2, 0], after: HOUR_MS }),
          execA: executeWave(0, [4, 0]),
          execB: executeWave(1, [4, 1]),
          execC: executeWave(2, [4, 2]),
          Call: fact({ label: "Call", pos: [5, 1], value: 0, limit: ROLL_BATCHES }),
          results: slice({ label: "results", pos: [5, 2], size: ROLL_SIZE * ROLL_BATCHES }),
          ready: channel({ label: "ready", pos: [4, 3], cap: 0 }),
        },
        insight: `This scene shows the stop-before-fire order. Each wave fills four slots. It stops MaxWait before the callback starts. Each execution writes four ordered results. The scene does not model Stop returning false after a callback starts.`,
        stops: [
          {
            when: { op: "stop", node: "MaxWait" },
            say: "Reaching MaxBatchSize stops only the current batch timer before detaching it.",
          },
          {
            when: { op: "go", g: "callerA", node: "execA" },
            say: "The count trigger starts execution after Add releases the lock. The next batch can open at once.",
          },
          {
            when: { op: "go", g: "callerC", node: "execC" },
            say: "A and B already fired. C's four requests stay in their own batch and produce the third fn call.",
          },
        ],
        tests: { roll: tests.roll! },
        code: {
          file: "solution",
          text: `${solutionOpen("test")}\n…\n${solutionDetach("test")}\n…\n${solutionExecute("test")}`,
        },
        expect: { outcome: "ok", tests: { roll: "pass" } },
      },
    },
    {
      id: "shutdown",
      chip: "Close",
      tier: "inside",
      summary: `fn blocks after a full batch fires. Close waits on inflight. It times out at ${K.closeDeadline.value} ms. The fn call still finishes afterward.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 2],
            main: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield go("add[*]");
              yield recv("started");

              yield lock("mu", { at: "c.mu.Lock()" });
              yield set("closed", "closed", { at: "c.closed = true" });
              yield unlock("mu", { at: "c.mu.Unlock()" });
              yield go("waiter", { at: "go func()" });
              const r = yield select([onRecv("done"), onRecv("ctx")], { at: "select {" });
              if (r.i === 1) vars.timedOut = 1;
              yield close("release");

              const r0 = yield recv("ch0");
              const r1 = yield recv("ch1");
              vars.got0 = Number(r0.v);
              vars.got1 = Number(r1.v);
            },
          }),
          add: goroutine({
            label: "add[*]",
            pos: [1, 0],
            count: CLOSE_BATCH,
            spawned: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield lock("mu", { at: "c.mu.Lock()" });
              if ((vars.queued ?? 0) === 0) {
                yield set("batch", "batch", { at: "c.batch = b" });
              }
              vars.queued = (vars.queued ?? 0) + 1;

              let fire = false;
              if (vars.queued >= CLOSE_BATCH) {
                yield set("batch", "nil", { at: "c.batch = nil" });
                yield add("inflight", 1, { at: "c.inflight.Add(1)" });
                fire = true;
              }
              yield unlock("mu", { at: "c.mu.Unlock()" });
              if (fire) {
                yield go("execute", { at: "c.startExecute(b)" });
              }
            },
          }),
          mu: mutex({ label: "mu", pos: [2, 0] }),
          batch: fact({ label: "c.batch", pos: [2, 1], value: "nil", states: ["nil", "batch"] }),
          closed: fact({ label: "c.closed", pos: [2, 2], value: "open", states: ["open", "closed"] }),
          inflight: waitgroup({ label: "inflight", pos: [3, 0] }),
          execute: goroutine({
            label: "execute",
            pos: [3, 1],
            spawned: true,
            program: function* ({ vars }: { vars: Record<string, number> }) {
              yield close("started");
              yield recv("release");
              yield work(0, "doubleFn", { at: "responses, err := c.fn" });
              vars.callCount = (vars.callCount ?? 0) + 1;
              yield send("ch0", 2);
              yield send("ch1", 4);
              yield done("inflight", { at: "c.inflight.Done()" });
            },
          }),
          started: channel({ label: "started", pos: [4, 0], cap: 0 }),
          release: channel({ label: "release", pos: [4, 1], cap: 0 }),
          waiter: goroutine({
            label: "waiter",
            pos: [4, 2],
            spawned: true,
            program: function* () {
              yield wait("inflight", { at: "c.inflight.Wait()" });
              yield close("done", { at: "close(done)" });
            },
          }),
          done: channel({ label: "done", pos: [5, 2], cap: 0 }),
          ctx: {
            kind: "context",
            label: "ctx",
            pos: [5, 1],
            deadline: K.closeDeadline.value,
          },
          ch0: channel({ label: "ch0", pos: [5, 0], cap: 1 }),
          ch1: channel({ label: "ch1", pos: [5, 3], cap: 1 }),
        },
        insight: `Close sees that the count path already detached the batch. It marks the Collector closed and waits on inflight. At ${K.closeDeadline.value} ms ctx wins. Releasing fn later still sends both results.`,
        stops: [
          {
            when: { op: "set", node: "closed" },
            say: "Close first stops admission. The open-batch pointer is already nil because the count trigger detached it.",
          },
          {
            when: { op: "wait", g: "waiter", node: "inflight" },
            say: "The helper goroutine in Close waits for every fired batch to finish fn.",
          },
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.closeDeadline.value} ms Close returns DeadlineExceeded. The inflight count is still one, so fn keeps running.`,
          },
        ],
        tests: { close: tests.close! },
        clock: { unit: "ms", budget: { at: K.recvTimeoutS.value * 1000, label: "recv timeout" } },
        code: {
          file: "solution",
          text: `${solutionOpen("add")}\n…\n${solutionDetach("test")}\n…\n${SOLUTION_CLOSE}\n…\n${solutionExecute("execute")}`,
        },
        expect: { outcome: "ok", t: K.closeDeadline.value, tests: { close: "pass" } },
      },
    },
  ],
});
