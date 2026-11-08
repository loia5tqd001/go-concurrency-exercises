// 31 is a timing problem: one clock, one deadline, and a result channel whose
// buffer decides whether the losing send leaks. Serve runs on the test's own
// goroutine, so the caller node is the test function, and its last sleep is
// the test's wait for the handler before the synctest bubble closes.
//
// Goal stays at the README's level: the handler runs on its own goroutine
// and Serve waits on ctx. The README draws no result channel and no select,
// so Goal has neither; the inside scenes show both, and the buffer that
// keeps the late send from leaking.

import { channel, context, defineViz, fail, go, goroutine, onRecv, recv, select, send, sleep, work, cancel } from "../engine/ops.ts";
import type { Model, NodeDef, Self, TestDef } from "../engine/model.ts";

const K = {
  deadlineMs: { value: 100, file: "check_test.go", text: "ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)" },
  handlerMs: { value: 500, file: "check_test.go", text: 'h := NewMockHandler("too-late", 500*time.Millisecond)' },
  budgetMs: { value: 150, file: "check_test.go", text: "const budget = 150 * time.Millisecond" },
  settleMs: { value: 500, file: "check_test.go", text: "time.Sleep(500 * time.Millisecond)" },
  ampleHandlerMs: { value: 50, file: "check_test.go", text: 'h := NewMockHandler("payload", 50*time.Millisecond)' },
  ampleDeadlineS: { value: 2, file: "check_test.go", text: "ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)" },
  resultCap: { value: 1, file: "../solutions/31-serve-timeout-race.md", text: "resCh := make(chan result, 1)" },
} as const;

// The handler's value, shortened: "too-late" in the deadline test, "payload"
// in the ample one.
const VALUE = "v";

const tests: Record<string, TestDef> = {
  // Serve returned ctx.Err() (only the deadline sets err, at 100 ms, inside
  // the 150 ms budget), the handler ran to completion, and synctest found no
  // goroutine still blocked when the test returned.
  deadline: {
    name: "TestServeRespectsDeadlineWhenHandlerIgnoresCtx",
    short: "deadline",
    judge: (run) => run.vars.err === 1 && run.vars.completed === 1 && run.outcome === "ok",
  },
};

const ampleTests: Record<string, TestDef> = {
  ample: {
    name: "TestServeReturnsHandlerResultWithAmpleDeadline",
    short: "ample time",
    judge: (run) => run.vars.got === 1 && run.outcome === "ok",
  },
};

// h.Handler: sleep for its latency, mark completed, return its value.
function* handlerCall(vars: Self["vars"], ms: number) {
  yield work(ms, "handler()");
  vars.completed = 1;
}

const SOLUTION = (withMake: boolean): string =>
  [
    "@caller func Serve(ctx context.Context, handler func() (string, error)) (string, error) {",
    "…",
    ...(withMake ? ["@caller 	resCh := make(chan result, 1)", "@caller"] : []),
    "@caller 	go func() {",
    "@handler 		value, err := handler()",
    "@handler 		resCh <- result{value, err}",
    "@caller 	}()",
    "@caller",
    "@caller 	select {",
    "@caller 	case res := <-resCh:",
    "@caller 		return res.value, res.err",
    "@caller 	case <-ctx.Done():",
    '@caller 		return "", ctx.Err()',
    "@caller 	}",
    "@caller }",
  ].join("\n");

// The solution under one test: Serve races resCh against ctx.Done().
function inside(opts: { cap: number; handlerMs: number; deadlineMs: number; ample: boolean }): Pick<Model, "nodes" | "routes"> {
  const nodes: Record<string, NodeDef> = {
    handler: goroutine({
      label: "handler",
      pos: [0, 0],
      spawned: true,
      program: function* ({ vars }) {
        yield* handlerCall(vars, opts.handlerMs);
        yield send("resCh", VALUE);
      },
    }),
    resCh: channel({ label: "resCh", pos: [1, 0], cap: opts.cap }),
    caller: goroutine({
      label: "caller",
      pos: [2, 0],
      main: true,
      program: function* ({ vars }) {
        yield go("handler");
        const r: { i: number } = yield select([onRecv("resCh"), onRecv("ctx")]);
        if (r.i === 0) vars.got = 1;
        else vars.err = 1;
        if (opts.ample) {
          // The test's defer cancel() ends ctx before its 2 s deadline.
          yield cancel("ctx");
        } else {
          // The test waits for the handler before the bubble closes. Its
          // defer cancel() comes after the deadline, so it changes nothing.
          yield sleep(K.settleMs.value);
        }
      },
    }),
    ctx: context({ label: "ctx", pos: [2, 1], deadline: opts.deadlineMs }),
  };
  return { nodes };
}

const clock = { unit: "ms" } as const;

export default defineViz({
  schema: 3,
  exercise: "31-serve-timeout-race",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:d1b61a7a", goal: "fnv1a:d1b61a7a" },
  spoilerOk: {
    "ctx.Done": "the context's completion signal; this is how Go spells the wait",
  },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `Serve calls the handler inline and never reads ctx. The deadline passes at ${K.deadlineMs.value} ms. Serve returns at ${K.handlerMs.value} ms with no error.`,
      model: {
        nodes: {
          ctx: context({ label: "ctx", pos: [0, 0], deadline: K.deadlineMs.value }),
          caller: goroutine({
            label: "caller",
            pos: [1, 0],
            main: true,
            program: function* ({ vars }) {
              // return handler(): the caller waits inside it.
              yield* handlerCall(vars, K.handlerMs.value);
              // err == nil, so the test stops with t.Fatalf.
              yield fail("deadline");
            },
          }),
        },
        insight: `Serve receives ctx but never reads it. The caller waits inside handler() for ${K.handlerMs.value} ms. The ${K.deadlineMs.value} ms deadline passes with no watcher. Serve returns no error, long after the ${K.budgetMs.value} ms budget.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `The ${K.deadlineMs.value} ms deadline passes. Serve never checks ctx. The caller is still inside handler().`,
          },
          {
            when: { op: "fail" },
            say: `handler() returns at ${K.handlerMs.value} ms with no error. This is far past the ${K.budgetMs.value} ms budget. The test fails.`,
          },
        ],
        tests,
        clock,
        code: {
          file: "main.go",
          text: `
@caller func Serve(ctx context.Context, handler func() (string, error)) (string, error) {
@caller 	return handler()
@caller }`,
        },
        expect: { outcome: "ok", t: K.handlerMs.value, tests: { deadline: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Serve returns at the ${K.deadlineMs.value} ms deadline. The handler runs alone and finishes at ${K.handlerMs.value} ms. No one is listening.`,
      model: {
        nodes: {
          ctx: context({ label: "ctx", pos: [0, 0], deadline: K.deadlineMs.value }),
          caller: goroutine({
            label: "caller",
            pos: [1, 0],
            main: true,
            program: function* ({ vars }) {
              yield go("handler");
              yield recv("ctx");
              // return "", ctx.Err()
              vars.err = 1;
              // The test waits for the handler before the bubble closes.
              yield sleep(K.settleMs.value);
            },
          }),
          handler: goroutine({
            label: "handler",
            pos: [2, 0],
            spawned: true,
            program: function* ({ vars }) {
              yield* handlerCall(vars, K.handlerMs.value);
            },
          }),
        },
        insight: `The handler runs on its own goroutine. The caller can watch ctx. At ${K.deadlineMs.value} ms the deadline passes. Serve returns ctx.Err() in time. The handler cannot be stopped. It runs to ${K.handlerMs.value} ms with no listener.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms the deadline passes. Serve stops waiting and returns ctx.Err(). The handler keeps running.`,
          },
          {
            when: { op: "return", g: "handler" },
            say: `At ${K.handlerMs.value} ms the handler finishes alone. The test waits for this.`,
          },
        ],
        tests,
        clock,
        expect: { outcome: "ok", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "pass" } },
      },
    },
    {
      id: "handler",
      chip: "Handler",
      tier: "inside",
      summary: `With a ${K.ampleDeadlineS.value} s deadline, the handler result arrives first at ${K.ampleHandlerMs.value} ms. Serve returns the handler's value and error.`,
      model: {
        ...inside({ cap: K.resultCap.value, handlerMs: K.ampleHandlerMs.value, deadlineMs: K.ampleDeadlineS.value * 1000, ample: true }),
        insight: `The ${K.ampleHandlerMs.value} ms handler finishes well before the ${K.ampleDeadlineS.value} s deadline. The select takes resCh. Serve returns the value and error. After the handler returns, the test calls cancel. That ends ctx.`,
        stops: [
          {
            when: { op: "send", g: "handler" },
            say: `At ${K.ampleHandlerMs.value} ms the handler's result reaches the select first. Serve returns it.`,
          },
        ],
        tests: ampleTests,
        clock,
        code: { file: "solution", text: SOLUTION(true) },
        expect: { outcome: "ok", t: K.ampleHandlerMs.value, tests: { ample: "pass" } },
      },
    },
    {
      id: "deadline",
      chip: "Deadline",
      tier: "inside",
      summary: `The deadline wins at ${K.deadlineMs.value} ms. At ${K.handlerMs.value} ms the late send fills resCh's one slot. The handler returns.`,
      model: {
        ...inside({ cap: K.resultCap.value, handlerMs: K.handlerMs.value, deadlineMs: K.deadlineMs.value, ample: false }),
        insight: `The select races resCh against ctx.Done(). The deadline wins at ${K.deadlineMs.value} ms. Serve returns. No one reads resCh again. Its one slot takes the late send, so the handler ends.`,
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms ctx.Done() closes. The select takes that case, and Serve returns ctx.Err().`,
          },
          {
            when: { op: "send", g: "handler" },
            say: `At ${K.handlerMs.value} ms the handler's send fills the free resCh slot. No one reads it, but the handler returns.`,
          },
        ],
        tests,
        clock,
        code: { file: "solution", text: SOLUTION(true) },
        expect: { outcome: "ok", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "pass" } },
      },
    },
    {
      id: "leak",
      chip: "Leak",
      tier: "inside",
      summary: `This is the same race with an unbuffered resCh. Serve returns at ${K.deadlineMs.value} ms. At ${K.handlerMs.value} ms the handler's send has no receiver and blocks.`,
      model: {
        ...inside({ cap: 0, handlerMs: K.handlerMs.value, deadlineMs: K.deadlineMs.value, ample: false }),
        insight:
          "Without the buffer, the losing send needs a receiver. Serve has already gone. The handler blocks on resCh forever. synctest fails because a goroutine is still blocked.",
        stops: [
          {
            when: { op: "fire", node: "ctx" },
            say: `At ${K.deadlineMs.value} ms ctx.Done() closes, and Serve returns. No one will read resCh again.`,
          },
          {
            when: { op: "block", g: "handler" },
            say: `At ${K.handlerMs.value} ms the handler sends on resCh. It has no buffer and no receiver, so it blocks forever.`,
          },
        ],
        tests,
        clock,
        code: { file: "solution", text: SOLUTION(false) },
        expect: { outcome: "leak", t: K.deadlineMs.value + K.settleMs.value, tests: { deadline: "fail" } },
      },
    },
  ],
});
