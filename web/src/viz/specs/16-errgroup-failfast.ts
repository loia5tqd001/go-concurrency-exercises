// 16 is a throughput problem with a bookkeeping rule. The scaffold's Go calls
// f on the calling goroutine, so ten 100 ms tasks run one after another: 1 s.
// Go that starts a goroutine per task, counted by a WaitGroup, lets Wait join
// all ten after one latency. The inside scene shows the other half: when many
// tasks fail at once, sync.Once lets exactly one error through.
//
// Today and Goal are TestGroupRunsConcurrently. The inside scene is
// TestGroupFirstErrorRaceSafe (50 tasks that fail at once). The scaffold
// passes TestGroupRunsAllTasksToCompletion and TestGroupFirstErrorRaceSafe:
// run one at a time it never races.
//
// Not drawn: the data race itself. `-race` is not part of the run, so the
// inside scene judges only that Wait returned one task's error.

import {
  add,
  defineViz,
  done,
  fact,
  go,
  goroutine,
  set,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { Op } from "../engine/model.ts";

// What the engine sends back into a program: nothing here. `Program` in
// model.ts declares `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gen = Generator<Op, void, any>;

// Every number names its source in the committed exercise.
const K = {
  tasks: { value: 10, file: "check_test.go", text: "const n = 10" },
  latency: { value: 100, file: "check_test.go", text: "time.Sleep(100 * time.Millisecond)" },
  budget: { value: 300, file: "check_test.go", text: "const budget = 300 * time.Millisecond" },
  failing: { value: 50, file: "check_test.go", text: "const n = 50" },
} as const;

const N = K.tasks.value;

const tests = {
  concurrent: {
    name: "TestGroupRunsConcurrently",
    short: "time limit",
    judge: (run: { t: number }) => run.t < K.budget.value,
  },
};

const raceTests = {
  first: {
    name: "TestGroupFirstErrorRaceSafe",
    short: "first error",
    // Wait returned an error that belongs to some task.
    judge: (run: { vars: Readonly<Record<string, number>> }) => run.vars.won === 1,
  },
};

const clock = { unit: "ms", budget: { at: K.budget.value, label: "budget" } } as const;

export default defineViz({
  schema: 3,
  exercise: "16-errgroup-failfast",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:0e53606b", goal: "fnv1a:0e53606b" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `Go calls f on the calling goroutine. The ${N} tasks run one by one. They take ${N * K.latency.value} ms, over the ${K.budget.value} ms limit.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 0],
            main: true,
            program: function* (): Gen {
              for (let i = 0; i < N; i++) yield work(K.latency.value, "f()", { at: "err := f()" });
            },
          }),
        },
        insight: `Each Go call waits for its task. The next task cannot start yet. One goroutine runs all ${N} tasks. The clock reaches ${N * K.latency.value} ms, over three times the ${K.budget.value} ms budget.`,
        stops: [
          { when: { op: "work", nth: 2 }, say: `The first task has returned. The second task can start now, ${K.latency.value} ms in.` },
        ],
        tests,
        clock,
        code: {
          file: "main.go",
          text: `
@caller func (g *Group) Go(f func() error) {
@caller 	if err := f(); err != nil && g.firstErr == nil {
@caller 		g.firstErr = err
@caller 	}
@caller }`,
        },
        expect: { outcome: "ok", t: N * K.latency.value, tests: { concurrent: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Go starts each task in its own goroutine. All ${N} run at once. Wait joins them after ${K.latency.value} ms.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* (): Gen {
              for (let i = 0; i < N; i++) {
                yield add("wg", 1);
                yield go(`worker[${i}]`);
              }
              yield wait("wg");
            },
          }),
          wg: waitgroup({ label: "WaitGroup", pos: [1, 0] }),
          worker: goroutine({
            label: "worker",
            pos: [1, 1],
            count: N,
            spawned: true,
            program: function* (): Gen {
              yield work(K.latency.value, "f()");
              yield done("wg");
            },
          }),
        },
        insight: `Each Go call adds one task to the WaitGroup. It then starts a goroutine and returns at once. All ${N} tasks overlap. Wait returns when the count reaches 0, at ${K.latency.value} ms.`,
        stops: [
          { when: { op: "work", g: "worker", nth: N }, say: `All ${N} tasks are running. Wait blocks until the WaitGroup reaches 0.` },
        ],
        tests,
        clock,
        expect: { outcome: "ok", t: K.latency.value, tests: { concurrent: "pass" } },
      },
    },
    {
      id: "once",
      chip: "Once",
      tier: "inside",
      summary: `${K.failing.value} tasks fail at once. The first one to reach once.Do writes firstErr. Wait returns that error.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }): Gen {
              for (let i = 0; i < K.failing.value; i++) {
                yield add("wg", 1, { at: "g.wg.Add(1)" });
                yield go(`worker[${i}]`, { at: "go func() {" });
              }
              yield wait("wg", { at: "g.wg.Wait()" });
              // Wait returns g.firstErr: an error that belongs to some task.
              if (vars.winner !== undefined) vars.won = 1;
            },
          }),
          wg: waitgroup({ label: "WaitGroup", pos: [1, 0] }),
          worker: goroutine({
            label: "worker",
            pos: [1, 1],
            count: K.failing.value,
            spawned: true,
            program: function* ({ i, vars }): Gen {
              // g.once.Do: the first caller runs the closure, later callers skip it.
              if (vars.winner === undefined) {
                vars.winner = i;
                yield set("firstErr", `t${i}`, { at: "g.firstErr = err" });
              }
              yield done("wg", { at: "defer g.wg.Done()" });
            },
          }),
          firstErr: fact({ label: "firstErr", pos: [2, 1], value: "nil" }),
        },
        insight: `Every task fails with no delay. All ${K.failing.value} reach once.Do together. One task runs the closure and writes firstErr. The others skip it. Wait returns after the last Done, so every write is complete.`,
        stops: [
          { when: { op: "set", node: "firstErr" }, say: "One task reached once.Do first and wrote firstErr. Every later task skips the closure." },
        ],
        tests: raceTests,
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@caller type Group struct {
@caller 	wg       sync.WaitGroup
@caller 	once     sync.Once
@caller 	firstErr error
@caller }
@caller
@caller func (g *Group) Go(f func() error) {
@caller 	g.wg.Add(1)
@caller 	go func() {
@worker 		defer g.wg.Done()
@worker 		if err := f(); err != nil {
@worker 			g.once.Do(func() {
@worker 				g.firstErr = err
@worker 			})
@worker 		}
@caller 	}()
@caller }
@caller
@caller func (g *Group) Wait() error {
@caller 	g.wg.Wait()
@caller 	return g.firstErr
@caller }`,
        },
        expect: { outcome: "ok", t: 0, tests: { first: "pass" } },
      },
    },
  ],
});
