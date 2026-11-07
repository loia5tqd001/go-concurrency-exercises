// 39 separates saturation from latency. The scene follows
// TestSubmitFailsFastWhenQueueIsFull: the test starts one Submit caller per
// attempt and waits for that caller or a 200 ms timer. Accepted jobs block in
// Run until the test's deferred close(block), then the long-lived worker waits
// on jobs again because Queue has no Close method.

import {
  channel,
  close,
  defineViz,
  fact,
  go,
  goroutine,
  inc,
  onRecv,
  onSend,
  pass,
  fail,
  range,
  recv,
  reset,
  select,
  send,
  start,
  timer,
} from "../engine/ops.ts";
import type { Model, SelectResult, TestDef } from "../engine/model.ts";

const K = {
  workers: { value: 1, file: "check_test.go", text: "const workers = 1" },
  capacity: { value: 2, file: "check_test.go", text: "const capacity = 2" },
  deadline: { value: 200, file: "check_test.go", text: "const perCallDeadline = 200 * time.Millisecond" },
  margin: { value: 5, file: "check_test.go", text: "const attempts = capacity + workers + 5" },
} as const;

const attempts = K.capacity.value + K.workers.value + K.margin.value;

const tests: Record<string, TestDef> = {
  fast: {
    name: "TestSubmitFailsFastWhenQueueIsFull",
    short: "fails fast",
  },
};

function model(today: boolean): Model {
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 1],
        main: true,
        program: function* () {
          yield go("worker[0]");

          for (let i = 0; i < attempts; i++) {
            yield go(`caller[${i}]`);
            if (i === 0) yield start("after");
            else yield reset("after");

            const r: SelectResult = yield select([onRecv("done"), onRecv("after")]);
            if (r.i === 1) {
              yield fail("fast");
              yield close("block");
              return;
            }
            if (r.i === 0 && r.v === "hit") {
              yield inc("overloaded", 1, { at: "sawOverloaded = true" });
              yield pass("fast");
              yield close("block");
              return;
            }
          }

          yield fail("fast");
          yield close("block");
        },
      }),
      caller: goroutine({
        label: "caller",
        pos: [1, 1],
        count: attempts,
        spawned: true,
        program: function* ({ i }) {
          if (today) {
            yield send("jobs", i, { at: "q.jobs <- job" });
            yield inc("accepted", 1, { at: "q.jobs <- job" });
            yield send("done", null);
            return;
          }

          const r: SelectResult = yield select([onSend("jobs", i)], {
            default: true,
            at: "select {",
          });
          if (r.i < 0) {
            yield send("done", "hit");
            return;
          }

          yield inc("accepted", 1, { at: "case q.jobs <- job:" });
          yield send("done", null);
        },
      }),
      jobs: channel({ label: "jobs", pos: [2, 1], cap: K.capacity.value }),
      worker: goroutine({
        label: "worker",
        pos: [3, 1],
        count: K.workers.value,
        spawned: true,
        program: function* () {
          yield* range(
            "jobs",
            function* () {
              yield recv("block");
            },
            { at: "for job := range q.jobs" },
          );
        },
      }),
      // Only one attempt's done channel is live at a time. Reusing one node
      // preserves its cap-1 hand-off without inventing concurrent channels.
      block: channel({ label: "block", pos: [3, 2], cap: 0 }),
      done: channel({ label: "done", pos: [1, 2], cap: 1 }),
      // The test creates a new 200 ms time.After per call. Resetting this
      // sequential timer has the same observed outcome because old ticks are
      // never selected.
      after: timer({ label: "time.After", pos: [0, 2], after: K.deadline.value }),
      accepted: fact({ label: "accepted", pos: [2, 2], value: 0 }),
      overloaded: fact({ label: "overloaded", pos: [1, 3], value: 0, limit: 1 }),
    },
    insight: today
      ? `The worker is inside Run and waits on block. The next Submit caller is still blocked on jobs. The test's ${K.deadline.value} ms timer fires.`
      : `A Submit caller reaches select with no receiver and no free jobs slot. The default case returns ErrOverloaded. The test records it and stops. It does not try another call.`,
    stops: today
      ? [
          { when: { op: "block", g: "worker" }, say: "The worker takes a job and is inside Run, waiting on block." },
          { when: { op: "fire", node: "after" }, say: "The per-call deadline fires. The test fails." },
        ]
      : [
          { when: { op: "inc", node: "overloaded" }, say: "No send is ready, so Submit returns ErrOverloaded." },
          { when: { op: "pass", node: "fast" }, say: "The test sees ErrOverloaded and stops trying." },
        ],
    tests,
    clock: { unit: "ms", budget: { at: K.deadline.value, label: "deadline" } },
    expect: today
      ? { outcome: "leak", t: K.deadline.value, tests: { fast: "fail" } }
      : { outcome: "leak", t: 0, tests: { fast: "pass" } },
    until: today ? undefined : 0,
    code: today
      ? {
          file: "main.go",
          text: `
@caller func (q *Queue) Submit(job Job) error {
@caller 	q.jobs <- job
@caller 	return nil
@caller }

@worker func (q *Queue) worker() {
@worker 	for job := range q.jobs {
@worker 		job.Result <- job.Run()
@worker 	}
@worker }`,
        }
      : undefined,
  };
}

export default defineViz({
  schema: 3,
  exercise: "39-load-shedding",
  diagrams: { today: "fnv1a:cde11b70", goal: "fnv1a:cde11b70" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The Submit goroutine blocks when jobs is full. The test's ${K.deadline.value} ms timer wins and fails the test.`,
      model: model(true),
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "Submit tries the channel send once. With no room, default returns ErrOverloaded. The test stops.",
      model: model(false),
    },
  ],
});
