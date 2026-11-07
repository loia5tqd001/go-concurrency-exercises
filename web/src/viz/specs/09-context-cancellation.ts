// 09 is about a context that is passed down or not. The three layers are well
// behaved: each waits on its own 300 ms timer and on ctx.Done(). The scaffold
// hands them context.Background(), whose Done never fires, so the caller's
// 200 ms deadline passes unseen and all three layers run: 900 ms and no error.
// Handed the real ctx, the layer in flight returns ctx.Err() at the deadline,
// and the error check after each call stops the chain.
//
// The layers are calls on HandleRequest's own goroutine, not goroutines. Two
// facts stand for them: `layer` names the layer in flight, `returns` what
// HandleRequest returns; the timer is the one `callLayer` creates.
//
// Today and Goal are TestHandleRequestRespectsTimeout (a 200 ms deadline).
// TestHandleRequestCancelledMidway (cancel at 350 ms) is the inside scene.
// TestHandleRequestSucceedsWithAmpleTimeout passes on the scaffold.

import {
  cancel,
  channel,
  context,
  defineViz,
  fact,
  go,
  goroutine,
  onRecv,
  recv,
  select,
  send,
  sleep,
  set,
  start,
  stop,
  timer,
} from "../engine/ops.ts";
import type { Op, SelectResult, Self } from "../engine/model.ts";

// What the engine sends back into a program: a RecvResult, a SelectResult, or
// nothing. `Program` in model.ts declares the same `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, any, any>;

// Every number names its source in the committed exercise.
const K = {
  layer: { value: 300, file: "mocklayers.go", text: "const LayerLatency = 300 * time.Millisecond" },
  deadline: { value: 200, file: "check_test.go", text: "context.WithTimeout(context.Background(), 200*time.Millisecond)" },
  budget: { value: 350, file: "check_test.go", text: "const budget = 350 * time.Millisecond" },
  cancelAt: { value: 350, file: "check_test.go", text: "time.Sleep(350 * time.Millisecond)" },
  midBudget: { value: 500, file: "check_test.go", text: "const budget = 500 * time.Millisecond" },
} as const;

const LAYERS = ["A", "B", "C"] as const;

// The error HandleRequest returned, as the tests read it.
const DEADLINE = 1;
const CANCELED = 2;

const timeoutTests = {
  timeout: {
    name: "TestHandleRequestRespectsTimeout",
    short: "err, < 350 ms",
    // errors.Is(err, context.DeadlineExceeded) and elapsed < budget.
    judge: (run: { vars: Readonly<Record<string, number>>; t: number }) => run.vars.err === DEADLINE && run.t < K.budget.value,
  },
};

const midTests = {
  midway: {
    name: "TestHandleRequestCancelledMidway",
    short: "err, < 500 ms",
    judge: (run: { vars: Readonly<Record<string, number>>; t: number }) => run.vars.err !== undefined && run.t < K.midBudget.value,
  },
};

// callLayer as mocklayers.go writes it: arm a 300 ms timer, then select on the
// timer and on ctx.Done(). `listens` is false when HandleRequest handed the
// layer context.Background(), whose Done never fires. Returns true when the
// layer completed.
function* callLayer(layer: (typeof LAYERS)[number], listens: boolean, vars: Self["vars"], at: string): Gen {
  yield set("layer", layer, { at });
  yield start("timer", { at });
  if (!listens) {
    yield recv("timer", { at });
    return true;
  }
  const s: SelectResult = yield select([onRecv("timer"), onRecv("ctx")], { at });
  if (s.i === 1) {
    yield stop("timer", { at });
    vars.err = vars.canceled === 1 ? CANCELED : DEADLINE;
    return false;
  }
  return true;
}

const factNodes = () => ({
  layer: fact({ label: "layer", pos: [2, 0], value: "idle", states: ["idle", ...LAYERS] }),
  returns: fact({ label: "returns", pos: [2, 2], value: "–", states: ["–", "ABC", "ctx.Err()"] }),
});

// The chain: one layer after another, stopping at the first failure.
function* chain(listens: boolean, vars: Self["vars"], ats: readonly string[]): Gen {
  for (let i = 0; i < LAYERS.length; i++) {
    const ok: boolean = yield* callLayer(LAYERS[i]!, listens, vars, ats[i]!);
    if (!ok) {
      yield set("returns", "ctx.Err()");
      return;
    }
  }
  yield set("returns", "ABC");
}

const BG = ["CallLayerA(context.Background())", "CallLayerB(context.Background())", "CallLayerC(context.Background())"];
const REAL = ["CallLayerA(ctx)", "CallLayerB(ctx)", "CallLayerC(ctx)"];

const clock = { unit: "ms", budget: { at: K.budget.value, label: "budget" } } as const;

export default defineViz({
  schema: 3,
  exercise: "09-context-cancellation",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:ecd68536", goal: "fnv1a:ecd68536" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The layers get context.Background(), so the ${K.deadline.value} ms deadline passes unseen and all three layers run: ${3 * K.layer.value} ms, no error.`,
      model: {
        nodes: {
          ctx: context({ label: "ctx", pos: [0, 1], deadline: K.deadline.value }),
          main: goroutine({
            label: "caller",
            pos: [1, 1],
            main: true,
            program: function* ({ vars }): Gen {
              yield* chain(false, vars, BG);
            },
          }),
          timer: timer({ label: "timer", pos: [1, 0], after: K.layer.value }),
          ...factNodes(),
        },
        insight: `Each layer waits on its timer and on a Background context, which never ends. ctx passes its ${K.deadline.value} ms deadline with no edge from any layer, so every layer runs its full ${K.layer.value} ms and HandleRequest returns "ABC" and no error.`,
        stops: [
          { when: { op: "fire", node: "ctx" }, say: `The ${K.deadline.value} ms deadline passes. Nothing is listening: the layers hold Background(), not ctx.` },
        ],
        tests: timeoutTests,
        clock,
        code: {
          file: "main.go",
          text: `
@main func HandleRequest(ctx context.Context) (string, error) {
@main 	a, err := CallLayerA(context.Background())
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	b, err := CallLayerB(context.Background())
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	c, err := CallLayerC(context.Background())
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	return a + b + c, nil
@main }`,
        },
        expect: { outcome: "ok", t: 3 * K.layer.value, tests: { timeout: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `The layers get ctx, so the ${K.deadline.value} ms deadline reaches the layer in flight: it returns ctx.Err() and the other layers are skipped.`,
      model: {
        nodes: {
          ctx: context({ label: "ctx", pos: [0, 1], deadline: K.deadline.value }),
          main: goroutine({
            label: "caller",
            pos: [1, 1],
            main: true,
            program: function* ({ vars }): Gen {
              yield* chain(true, vars, REAL);
            },
          }),
          timer: timer({ label: "timer", pos: [1, 0], after: K.layer.value }),
          ...factNodes(),
        },
        insight: `Now the layer waits on its timer and on ctx.Done(). At ${K.deadline.value} ms the deadline wins, the layer returns ctx.Err(), and HandleRequest returns DeadlineExceeded at once. CallLayerB and CallLayerC never start.`,
        stops: [
          { when: { op: "fire", node: "ctx" }, say: `At ${K.deadline.value} ms the deadline passes. The layer in flight sees ctx.Done() before its ${K.layer.value} ms timer and returns ctx.Err().` },
        ],
        tests: timeoutTests,
        clock,
        expect: { outcome: "ok", t: K.deadline.value, tests: { timeout: "pass" } },
      },
    },
    {
      id: "cancel",
      chip: "Cancel",
      tier: "inside",
      summary: `A cancel at ${K.cancelAt.value} ms lands while CallLayerB is in flight: it returns context.Canceled, C is skipped, and the chain ends at ${K.cancelAt.value} ms.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }): Gen {
              yield go("main");
              yield sleep(K.cancelAt.value);
              vars.canceled = 1;
              yield cancel("ctx");
              yield recv("resCh");
            },
          }),
          ctx: context({ label: "ctx", pos: [0, 0] }),
          main: goroutine({
            label: "caller",
            pos: [1, 1],
            spawned: true,
            program: function* ({ vars }): Gen {
              yield* chain(true, vars, REAL);
              yield send("resCh", "res");
            },
          }),
          timer: timer({ label: "timer", pos: [1, 0], after: K.layer.value }),
          resCh: channel({ label: "resCh", pos: [1, 2], cap: 1 }),
          ...factNodes(),
        },
        insight: `Layer A finishes at ${K.layer.value} ms. Layer B has ${K.cancelAt.value - K.layer.value} ms on its timer when the test cancels ctx, so it returns context.Canceled, C is skipped, and the result reaches the test at ${K.cancelAt.value} ms, well inside ${K.midBudget.value} ms.`,
        stops: [
          { when: { op: "cancel", node: "ctx" }, say: `The test cancels ctx at ${K.cancelAt.value} ms, while CallLayerB is waiting on its timer.` },
        ],
        tests: midTests,
        clock: { unit: "ms", budget: { at: K.midBudget.value, label: "budget" } },
        code: {
          file: "solution",
          text: `
@main func HandleRequest(ctx context.Context) (string, error) {
@main 	if err := ctx.Err(); err != nil {
@main 		return "", err
@main 	}
@main
@main 	a, err := CallLayerA(ctx)
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	if err := ctx.Err(); err != nil {
@main 		return "", err
@main 	}
@main
@main 	b, err := CallLayerB(ctx)
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	if err := ctx.Err(); err != nil {
@main 		return "", err
@main 	}
@main
@main 	c, err := CallLayerC(ctx)
@main 	if err != nil {
@main 		return "", err
@main 	}
@main
@main 	return a + b + c, nil
@main }`,
        },
        expect: { outcome: "ok", t: K.cancelAt.value, tests: { midway: "pass" } },
      },
    },
  ],
});
