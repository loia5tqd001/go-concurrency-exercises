// 08 is a throughput problem. The scaffold runs square over the whole slice,
// then keepEven over the whole slice, on the caller's own goroutine, so 20
// items cost two full stages: 400 ms. As three stage goroutines joined by
// unbuffered channels, the stages work on different items at the same time,
// and the run costs one stage plus two hand-offs: 220 ms. The inside scene
// closes done early and shows every stage leave through its done case.

import { channel, close, defineViz, go, goroutine, onRecv, onSend, pass, put, range, select, send, sleep, slice, work, append } from "../engine/ops.ts";
import type { RunSummary, Self, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  items: { value: 20, file: "check_test.go", text: "nums := rangeNums(20)" },
  workMs: { value: 10, file: "mockwork.go", text: "const WorkLatency = 10 * time.Millisecond" },
  budget: { value: 250, file: "check_test.go", text: "const budget = 250 * time.Millisecond" },
  hugeInput: { value: 100, file: "check_test.go", text: "const hugeInput = 100" },
  earlyBudget: { value: 200, file: "check_test.go", text: "const budget = 200 * time.Millisecond" },
} as const;

const N = K.items.value;
const W = K.workMs.value;
// rangeNums(n) is [1, n].
const rangeNums = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const evenSquares = rangeNums(N)
  .map((n) => n * n)
  .filter((sq) => sq % 2 === 0);

// The caller checks each result against the answer, as the tests do.
function collect(vars: Self["vars"], v: unknown): void {
  const k = vars.got ?? 0;
  if (v !== evenSquares[k]) vars.wrong = 1;
  vars.got = k + 1;
}

const right = (run: RunSummary): boolean => run.vars.got === evenSquares.length && run.vars.wrong === undefined;

const tests: Record<string, TestDef> = {
  correctness: { name: "TestPipelineCorrectness", short: "correctness", judge: right },
  overlap: {
    name: "TestPipelineStagesOverlap",
    short: `under ${K.budget.value} ms`,
    judge: (run) => right(run) && run.t < K.budget.value,
  },
};

const clock = { unit: "ms", budget: { at: K.budget.value, label: "budget" } } as const;

// The stage goroutines, joined by unbuffered channels. In the Problem tier
// the stages send and receive plainly: done is never closed during this run,
// so watching it changes no order, and the README draws no more than this.
const flow = {
  generator: goroutine({
    label: "generator",
    pos: [0, 1],
    spawned: true,
    program: function* () {
      for (const n of rangeNums(N)) {
        yield work(W, "SimulateWork");
        yield send("nums", n);
      }
      yield close("nums");
    },
  }),
  nums: channel({ label: "nums", pos: [0.5, 0], cap: 0 }),
  square: goroutine({
    label: "square",
    pos: [1, 1],
    spawned: true,
    program: function* () {
      yield* range("nums", function* (r) {
        yield work(W, "SimulateWork");
        yield send("squares", Number(r.v) * Number(r.v));
      });
      yield close("squares");
    },
  }),
  squares: channel({ label: "squares", pos: [1.5, 0], cap: 0 }),
  keepEven: goroutine({
    label: "keepEven",
    pos: [2, 1],
    spawned: true,
    program: function* () {
      yield* range("squares", function* (r) {
        yield work(W, "SimulateWork");
        if (Number(r.v) % 2 === 0) yield send("evens", r.tok!);
      });
      yield close("evens");
    },
  }),
  evens: channel({ label: "evens", pos: [2.5, 0], cap: 0 }),
};

// The caller starts every stage, so its go edges bend under the stages
// instead of crossing them. Under the stages they miss the channels' marks.
const routes = { "caller>square": "below", "caller>generator": "below" } as const;

export default defineViz({
  schema: 3,
  exercise: "08-pipeline",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:ecdd6dc8", goal: "fnv1a:ecdd6dc8" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `One goroutine squares all ${N} numbers, then filters all ${N}, so the run takes ${2 * N * W} ms and misses the ${K.budget.value} ms budget.`,
      model: {
        nodes: {
          // One column, so the 20 cells of squares stay readable on a phone.
          squares: slice({ label: "squares", pos: [0, 0], size: N }),
          evens: slice({ label: "evens", pos: [0, 2], size: evenSquares.length }),
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }) {
              // generator returns nums as it is: no work, no wait.
              const nums = rangeNums(N);
              for (const [i, n] of nums.entries()) {
                yield work(W, "square", { at: "for i, n := range nums {" });
                yield put("squares", i, n * n, { at: "out[i] = n * n" });
              }
              for (const n of nums) {
                yield work(W, "keepEven", { at: "for _, n := range nums {" });
                if ((n * n) % 2 === 0) {
                  yield append("evens", n * n, { at: "out = append(out, n)" });
                  collect(vars, n * n);
                }
              }
            },
          }),
        },
        insight: `One goroutine runs square over all ${N} numbers, then keepEven over all ${N}. Neither stage starts until the one before has finished the whole batch, so the clock reaches ${2 * N * W} ms, past the ${K.budget.value} ms budget.`,
        stops: [
          {
            when: { op: "put", node: "squares", nth: N },
            say: `At ${N * W} ms square has squared all ${N} numbers. Only now does keepEven start on the first one.`,
          },
        ],
        tests,
        clock,
        code: {
          file: "main.go",
          text: `
@caller func square(done <-chan struct{}, nums []int) []int {
@caller 	out := make([]int, len(nums))
@caller 	for i, n := range nums {
@caller 		SimulateWork()
@caller 		out[i] = n * n
@caller 	}
@caller 	return out
@caller }
…
@caller func keepEven(done <-chan struct{}, nums []int) []int {
@caller 	var out []int
@caller 	for _, n := range nums {
@caller 		SimulateWork()
@caller 		if n%2 == 0 {
@caller 			out = append(out, n)
@caller 		}
@caller 	}
@caller 	return out
@caller }
…
@caller func Pipeline(done <-chan struct{}, nums ...int) []int {
@caller 	return keepEven(done, square(done, generator(done, nums...)))
@caller }`,
        },
        expect: { outcome: "ok", t: 2 * N * W, tests: { correctness: "pass", overlap: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Three stage goroutines pass the ${N} numbers along unbuffered channels one at a time, so the run ends at ${N * W + 2 * W} ms.`,
      model: {
        nodes: {
          ...flow,
          caller: goroutine({
            label: "caller",
            pos: [3, 1],
            main: true,
            program: function* ({ vars }) {
              yield go("generator");
              yield go("square");
              yield go("keepEven");
              yield* range("evens", function* (r) {
                collect(vars, r.v);
              });
            },
          }),
        },
        routes,
        insight: `Each stage takes the next number as soon as it has passed the last one on, so all three work at once. The run costs one stage over ${N} numbers plus two hand-offs: ${N * W + 2 * W} ms. Each stage closes its channel when its input runs dry.`,
        stops: [
          {
            when: { op: "work", t: 2 * W, nth: 3 },
            say: `At ${2 * W} ms all three stages work at once: generator on 3, square on 2, keepEven on 1.`,
          },
          {
            when: { op: "close", node: "evens" },
            say: `The closes cascade: nums, squares, then evens. The caller's range ends at ${N * W + 2 * W} ms, under the budget.`,
          },
        ],
        tests,
        clock,
        expect: { outcome: "ok", t: N * W + 2 * W, tests: { correctness: "pass", overlap: "pass" } },
      },
    },
    {
      id: "stop",
      chip: "Stop",
      tier: "inside",
      summary: `A test goroutine closes done after ${W} ms; every stage leaves through its done case, and Pipeline returns at ${W} ms.`,
      model: {
        nodes: {
          // TestPipelineStopsEarly: 100 numbers, done closed after WorkLatency.
          generator: goroutine({
            label: "generator",
            pos: [1, 1.15],
            spawned: true,
            program: function* () {
              for (const n of rangeNums(K.hugeInput.value)) {
                yield work(W, "SimulateWork");
                const s = yield select([onSend("nums", n), onRecv("done")]);
                if (s.i === 1) break;
              }
              yield close("nums", { at: "defer close(out)" });
            },
          }),
          nums: channel({ label: "nums", pos: [1.35, 0], cap: 0 }),
          square: goroutine({
            label: "square",
            pos: [2, 1.15],
            spawned: true,
            program: function* () {
              for (;;) {
                const r = yield select([onRecv("nums"), onRecv("done")]);
                if (r.i === 1 || !r.ok) break;
                yield work(W, "SimulateWork");
                const s = yield select([onSend("squares", Number(r.v) * Number(r.v)), onRecv("done")], {
                  at: "case out <- n * n:",
                });
                if (s.i === 1) break;
              }
              yield close("squares", { at: "defer close(out)" });
            },
          }),
          squares: channel({ label: "squares", pos: [2.65, 0], cap: 0 }),
          keepEven: goroutine({
            label: "keepEven",
            pos: [3, 1.15],
            spawned: true,
            program: function* () {
              for (;;) {
                const r = yield select([onRecv("squares"), onRecv("done")]);
                if (r.i === 1 || !r.ok) break;
                yield work(W, "SimulateWork");
                if (Number(r.v) % 2 !== 0) continue;
                const s = yield select([onSend("evens", r.tok!), onRecv("done")]);
                if (s.i === 1) break;
              }
              yield close("evens", { at: "defer close(out)" });
            },
          }),
          evens: channel({ label: "evens", pos: [3.5, 0], cap: 0 }),
          caller: goroutine({
            label: "caller",
            pos: [4, 1.15],
            main: true,
            program: function* () {
              yield go("closer");
              yield go("generator");
              yield go("square");
              yield go("keepEven");
              yield* range("evens", function* () {});
              // The test measures elapsed here: Pipeline has returned.
              yield pass("stops");
            },
          }),
          closer: goroutine({
            label: "closer",
            pos: [0, 1.15],
            spawned: true,
            program: function* () {
              yield sleep(W);
              yield close("done");
            },
          }),
          done: channel({ label: "done", pos: [2, 0], cap: 0 }),
        },
        routes: { ...routes, "caller>closer": "below", "closer>done": "above" },
        insight: `Every stage selects on done at each send and receive, and closes its channel on every way out. One close(done) frees all three stages, and the closes reach the caller's range at once.`,
        stops: [
          {
            when: { op: "close", node: "done" },
            say: `At ${W} ms the test closes done. Each stage leaves at its next select, through the done case.`,
          },
          {
            when: { op: "close", node: "evens" },
            say: `keepEven's deferred close ends the caller's range. Pipeline returns at ${W} ms, far under ${K.earlyBudget.value} ms.`,
          },
        ],
        tests: { stops: { name: "TestPipelineStopsEarly", short: `under ${K.earlyBudget.value} ms` } },
        clock: { unit: "ms", budget: { at: K.earlyBudget.value, label: "budget" } },
        // keepEven runs the same loop as square; only its filter and the
        // value it sends differ, so it shares square's lines but the n * n send.
        code: {
          file: "solution",
          text: `
@generator 		defer close(out)
@generator 		for _, n := range nums {
@generator 			SimulateWork()
@generator 			select {
@generator 			case out <- n:
@generator 			case <-done:
@generator 				return
@generator 			}
@generator 		}
…
@square,keepEven 		defer close(out)
@square,keepEven 		for {
@square,keepEven 			select {
@square,keepEven 			case n, ok := <-in:
@square,keepEven 				if !ok {
@square,keepEven 					return
@square,keepEven 				}
@square,keepEven 				SimulateWork()
@square,keepEven 				select {
@square 				case out <- n * n:
@square,keepEven 				case <-done:
@square,keepEven 					return
@square,keepEven 				}
@square,keepEven 			case <-done:
@square,keepEven 				return
@square,keepEven 			}
@square,keepEven 		}
…
@caller 	for n := range evensCh {
@caller 		out = append(out, n)
@caller 	}`,
        },
        expect: { outcome: "ok", tests: { stops: "pass" } },
      },
    },
  ],
});
