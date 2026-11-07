// 32 is a deadline problem. Four ctx-blind components write disjoint fields of
// one result; the deadline can stop Construct from waiting, but it cannot stop
// those writers. Today ends at 500 ms. The timeout scenes end at 600 ms because
// Construct returns at 100 ms and the test then sleeps 500 ms for history.
// Ample finishes at 20 ms.
//
// Today and Goal stay on the two shapes in the README. The Inside scenes show
// the committed solution: a waiter turns wg.Wait() into a channel operation,
// the caller races that channel against ctx.Done(), and the timeout path
// returns nil without reading result.

import {
  add,
  cancel,
  channel,
  close,
  context,
  defineViz,
  done,
  fail,
  fact,
  go,
  goroutine,
  inc,
  onRecv,
  put,
  recv,
  select,
  send,
  sleep,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { Model, NodeDef, TestDef } from "../engine/model.ts";

const K = {
  fastMs: {
    value: 20,
    file: "check_test.go",
    text: 'basic := NewMockComponent("basic-ok", 20*time.Millisecond)',
  },
  historyMs: {
    value: 500,
    file: "check_test.go",
    text: 'history := NewMockComponent("history-ok", 500*time.Millisecond)',
  },
  deadlineMs: {
    value: 100,
    file: "check_test.go",
    text: "ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)",
  },
  budgetMs: {
    value: 150,
    file: "check_test.go",
    text: "const budget = 150 * time.Millisecond",
  },
  settleMs: {
    value: 500,
    file: "check_test.go",
    text: "time.Sleep(500 * time.Millisecond)",
  },
  ampleDeadlineS: {
    value: 2,
    file: "check_test.go",
    text: "ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)",
  },
  components: {
    value: 4,
    file: "main.go",
    text: "wg.Add(4)",
  },
} as const;

const FIELD_VALUES = ["b", "s", "r", "h"] as const;

const stallTest: TestDef = {
  name: "TestConstructRespectsDeadlineWhenAComponentStalls",
  short: "stall",
  judge: (run) =>
    run.vars.err === 1 &&
    run.vars.nil === 1 &&
    (run.vars.elapsed ?? Infinity) < K.budgetMs.value &&
    run.vars.history === 1 &&
    run.outcome === "ok",
};

const ampleTest: TestDef = {
  name: "TestConstructReturnsAllFieldsWithAmpleDeadline",
  short: "ample time",
  judge: (run) => run.vars.got === 1 && run.outcome === "ok",
};

const tests = { deadline: stallTest };
const ampleTests = { ample: ampleTest };
const clock = { unit: "ms", budget: { at: K.budgetMs.value, label: "budget" } } as const;

function component(
  label: string,
  pos: readonly [number, number],
  field: number,
  value: string,
  latency: number,
  opts: { countFact?: string; signal?: string; withWG?: boolean } = {},
): NodeDef {
  const { countFact, signal, withWG = true } = opts;
  return goroutine({
    label,
    pos,
    spawned: true,
    tone: field,
    program: function* ({ vars }) {
      // m.Component(): sleep for the full latency, then return its value.
      yield work(latency, "Component()");
      if (label === "history") vars.history = 1;
      if (countFact !== undefined) yield inc(countFact);
      if (signal !== undefined) yield send(signal, value);
      yield put("result", field, value);
      if (withWG) yield done("wg");
    },
  });
}

function components(
  historyMs: number,
  opts: { countFact?: string; signal?: string; withWG?: boolean } = {},
): Record<string, NodeDef> {
  return {
    basic: component("basic", [0, 0], 0, FIELD_VALUES[0], K.fastMs.value, opts),
    shipping: component("shipping", [0, 1], 1, FIELD_VALUES[1], K.fastMs.value, opts),
    refund: component("refund", [0, 2], 2, FIELD_VALUES[2], K.fastMs.value, opts),
    history: component("history", [0, 3], 3, FIELD_VALUES[3], historyMs, opts),
  };
}

const TODAY_CODE = `
@caller func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
@caller 	var result Result
@caller 	var wg sync.WaitGroup
@caller
@caller 	wg.Add(4)
@basic 	go func() {
@basic 		defer wg.Done()
@basic 		result.Basic = basic()
@basic 	}()
@shipping 	go func() {
@shipping 		defer wg.Done()
@shipping 		result.Shipping = shipping()
@shipping 	}()
@refund 	go func() {
@refund 		defer wg.Done()
@refund 		result.Refund = refund()
@refund 	}()
@history 	go func() {
@history 		defer wg.Done()
@history 		result.History = history()
@history 	}()
@caller
@caller 	wg.Wait()
@caller 	return &result, nil
@caller }`;

const SOLUTION_CODE = `
@caller func Construct(ctx context.Context, basic, shipping, refund, history Component) (*Result, error) {
@caller 	var result Result
@caller 	var wg sync.WaitGroup
@caller
@caller 	wg.Add(4)
@basic 	go func() { defer wg.Done(); result.Basic = basic() }()
@shipping 	go func() { defer wg.Done(); result.Shipping = shipping() }()
@refund 	go func() { defer wg.Done(); result.Refund = refund() }()
@history 	go func() { defer wg.Done(); result.History = history() }()
@caller
@caller 	done := make(chan struct{})
@caller 	go func() {
@waiter 		wg.Wait()
@waiter 		close(done)
@waiter 	}()
@caller
@caller 	select {
@caller 	case <-done:
@caller 		return &result, nil
@caller 	case <-ctx.Done():
@caller 		return nil, ctx.Err()
@caller 	}
@caller }`;

// The committed solution's race, with the key stall test on the side. The
// caller represents both Construct and the test: after Construct returns at
// 100 ms, the test checks the result and then sleeps 500 ms for history.
function solved(opts: { historyMs: number; deadlineMs: number; ample: boolean }): Pick<Model, "nodes" | "routes"> {
  const nodes: Record<string, NodeDef> = {
    ...components(opts.historyMs),
    result: {
      kind: "slice",
      label: "result",
      pos: [1, 2],
      size: K.components.value,
    },
    wg: waitgroup({ label: "wg", pos: [2, 0] }),
    done: channel({ label: "done", pos: [2, 1], cap: 0 }),
    waiter: goroutine({
      label: "waiter",
      pos: [2, 3],
      spawned: true,
      program: function* () {
        yield wait("wg");
        yield close("done");
      },
    }),
    caller: goroutine({
      label: "caller",
      pos: [3, 2],
      main: true,
      program: function* ({ vars }) {
        yield add("wg", K.components.value);
        yield go("basic");
        yield go("shipping");
        yield go("refund");
        yield go("history");
        yield go("waiter");

        const choice = yield select([onRecv("done"), onRecv("ctx")]);
        if (choice.i === 0) {
          vars.got = 1;
          if (opts.ample) {
            // The test's deferred cancel runs after Construct returns.
            yield cancel("ctx");
          }
          return;
        }

        vars.err = 1;
        vars.nil = 1;
        vars.elapsed = K.deadlineMs.value;

        // The test waits for the abandoned history call before synctest closes.
        yield sleep(K.settleMs.value);
      },
    }),
    ctx: context({
      label: "ctx",
      pos: [3, 4],
      deadline: opts.deadlineMs,
    }),
  };

  return { nodes };
}

export default defineViz({
  schema: 3,
  exercise: "32-fanout-deadline-race",
  diagrams: { today: "fnv1a:698a6454", goal: "fnv1a:698a6454" },
  constants: K,
  spoilerOk: {
    select: "The README already draws completion racing against ctx.Done().",
  },
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The ${K.deadlineMs.value} ms deadline passes while history runs for ${K.historyMs.value} ms. Construct ignores ctx and keeps waiting.`,
      model: {
        nodes: {
          ...components(K.historyMs.value),
          result: {
            kind: "slice",
            label: "result",
            pos: [1, 2],
            size: K.components.value,
          },
          wg: waitgroup({ label: "wg", pos: [1, 4] }),
          caller: goroutine({
            label: "caller",
            pos: [2, 2],
            main: true,
            program: function* () {
              yield add("wg", K.components.value);
              yield go("basic");
              yield go("shipping");
              yield go("refund");
              yield go("history");
              yield wait("wg");
              yield fail("deadline");
            },
          }),
          ctx: context({ label: "ctx", pos: [3, 4], deadline: K.deadlineMs.value }),
        },
        insight: `Construct starts every component. wg.Wait() never reads ctx. The ${K.deadlineMs.value} ms deadline passes while history runs. Construct returns only after ${K.historyMs.value} ms with a result.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms the deadline passes. Construct is still blocked in wg.Wait(). ctx has no effect.`,
          },
          {
            when: { op: "fail" },
            say: `At ${K.historyMs.value} ms the last component finishes. The test sees no error and a result instead of nil. This is far past its ${K.budgetMs.value} ms budget.`,
          },
        ],
        tests,
        clock,
        code: { file: "main.go", text: TODAY_CODE },
        expect: { outcome: "ok", t: K.historyMs.value, tests: { deadline: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Completion races the ${K.deadlineMs.value} ms deadline. The deadline wins. Construct returns nil and ctx.Err() while history keeps writing.`,
      model: {
        nodes: {
          ...components(K.historyMs.value, { signal: "finished", withWG: false }),
          result: {
            kind: "slice",
            label: "result",
            pos: [1, 2],
            size: K.components.value,
          },
          finished: channel({
            label: "finished",
            pos: [2, 1],
            cap: K.components.value,
          }),
          caller: goroutine({
            label: "caller",
            pos: [3, 2],
            main: true,
            program: function* ({ vars }) {
              yield go("basic");
              yield go("shipping");
              yield go("refund");
              yield go("history");

              for (let received = 0; received < K.components.value; received++) {
                const choice = yield select([onRecv("finished"), onRecv("ctx")]);
                if (choice.i === 1) {
                  vars.err = 1;
                  vars.nil = 1;
                  vars.elapsed = K.deadlineMs.value;
                  yield sleep(K.settleMs.value);
                  return;
                }
              }
              vars.got = 1;
            },
          }),
          ctx: context({
            label: "ctx",
            pos: [3, 4],
            deadline: K.deadlineMs.value,
          }),
        },
        insight: `All four components must finish, or the deadline ends the wait. Three finish at ${K.fastMs.value} ms. The history component still runs at ${K.deadlineMs.value} ms. Construct returns nil, ctx.Err(). The history component runs until ${K.historyMs.value} ms.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms the wait ends with ctx.Err(). The result is incomplete because the history component still runs.`,
          },
          {
            when: { op: "put", g: "history" },
            say: `The history component writes its field at ${K.historyMs.value} ms, after Construct returns nil. The caller must not read result.`,
          },
        ],
        tests,
        clock,
        expect: { outcome: "ok", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "pass" } },
      },
    },
    {
      id: "no-stop",
      chip: "No stop",
      tier: "inside",
      summary: `The ${K.deadlineMs.value} ms deadline cannot stop the components. Three finish at ${K.fastMs.value} ms. history keeps working for ${K.historyMs.value} ms.`,
      model: {
        nodes: {
          ...components(K.historyMs.value, { countFact: "completed", withWG: false }),
          result: {
            kind: "slice",
            label: "result",
            pos: [1, 2],
            size: K.components.value,
          },
          caller: goroutine({
            label: "caller",
            pos: [2, 2],
            main: true,
            program: function* ({ vars }) {
              yield go("basic");
              yield go("shipping");
              yield go("refund");
              yield go("history");
              yield recv("ctx");
              vars.err = 1;
              vars.nil = 1;
              vars.elapsed = K.deadlineMs.value;
              // The test lets the abandoned component finish.
              yield sleep(K.settleMs.value);
            },
          }),
          ctx: context({
            label: "ctx",
            pos: [3, 4],
            deadline: K.deadlineMs.value,
          }),
          completed: fact({
            label: "completed",
            pos: [1, 4],
            value: 0,
            limit: K.components.value,
            unit: "calls",
          }),
        },
        insight: `ctx expires at ${K.deadlineMs.value} ms, but the components never read it. Three have finished. The history component keeps its progress and writes result at ${K.historyMs.value} ms.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms ctx is done. The history component is still inside Component(). Cancellation cannot reach it.`,
          },
          {
            when: { op: "put", g: "history" },
            say: `At ${K.historyMs.value} ms the history component finishes its call and writes its field. Leaving the wait did not cancel the work.`,
          },
        ],
        tests,
        clock,
        expect: { outcome: "ok", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "pass" } },
      },
    },
    {
      id: "deadline",
      chip: "Deadline",
      tier: "inside",
      summary: `The waiter closes done only after all four finish. At ${K.deadlineMs.value} ms ctx wins. Construct returns nil while history keeps writing.`,
      model: {
        ...solved({
          historyMs: K.historyMs.value,
          deadlineMs: K.deadlineMs.value,
          ample: false,
        }),
        insight: `The caller races done against ctx.Done(). At ${K.deadlineMs.value} ms ctx wins. Construct returns nil, ctx.Err(). The history component still runs and writes result at ${K.historyMs.value} ms. Returning the pointer would be unsafe.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms ctx.Done() closes. The select takes that case and returns nil, ctx.Err().`,
          },
          {
            when: { op: "put", g: "history" },
            say: `The history component is still writing at ${K.historyMs.value} ms. Returning result here would expose a struct without synchronization.`,
          },
        ],
        tests,
        clock,
        code: { file: "solution", text: SOLUTION_CODE },
        expect: { outcome: "ok", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "pass" } },
      },
    },
    {
      id: "ample",
      chip: "Ample",
      tier: "inside",
      summary: `With a ${K.ampleDeadlineS.value} s deadline, all four components finish at ${K.fastMs.value} ms. The done channel wins, so returning the result is safe.`,
      model: {
        ...solved({
          historyMs: K.fastMs.value,
          deadlineMs: K.ampleDeadlineS.value * 1000,
          ample: true,
        }),
        insight: `All four writers finish at ${K.fastMs.value} ms. The waiter closes done after wg.Wait() returns. This is the success path. Returning &result is safe.`,
        stops: [
          {
            when: { op: "close", g: "waiter" },
            say: `At ${K.fastMs.value} ms wg.Wait() returns and done closes. All four result fields are written.`,
          },
          {
            when: { op: "cancel", g: "caller" },
            say: `The done channel wins, so the caller takes the success path. The test's deferred cancel then ends ctx.`,
          },
        ],
        tests: ampleTests,
        clock,
        code: { file: "solution", text: SOLUTION_CODE },
        expect: { outcome: "ok", t: K.fastMs.value, tests: { ample: "pass" } },
      },
    },
  ],
});
