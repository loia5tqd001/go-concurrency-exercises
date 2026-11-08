// 11 is a concurrency-count problem, and the count has two sides. The scaffold
// runs every job on the calling goroutine, so one RunJob is in flight at a
// time. Fanning out one goroutine per job puts all of them in flight. A pool
// keeps the number small and fixed, whatever the number of jobs: workers pull
// from a shared jobs channel, and two closes (jobs chan, then results chan)
// let every loop end.
//
// The run is TestProcessJobsIsBounded: 60 jobs, and a check of the high-water
// mark of RunJob calls. TestProcessJobsCorrectness and TestProcessJobsRace
// are other runs (20 and 50 jobs); the scaffold passes both, so no scene
// judges them.
//
// Not drawn: the []Result slice the caller fills, and whether a Result carries
// ErrJobFailed (every third job). The token a job carries is its ID.

import { add, channel, close, defineViz, done, fact, go, goroutine, inc, range, send, wait, waitgroup, work } from "../engine/ops.ts";
import type { Model, Op, Params, Self, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  jobs: { value: 60, file: "check_test.go", text: "const numJobs = 60" },
  latency: { value: 80, file: "mockjobs.go", text: "const JobLatency = 80 * time.Millisecond" },
  poolMax: { value: 20, file: "check_test.go", text: "const maxReasonablePoolSize = 20" },
  floor: { value: 1, file: "check_test.go", text: "if hwm <= 1 {" },
  workers: { value: 4, file: "../solutions/11-worker-pool.md", text: "const numWorkers = 4" },
} as const;

const N = K.jobs.value;
const ROUND = K.latency.value;

const tests: Record<string, TestDef> = {
  bounded: {
    name: "TestProcessJobsIsBounded",
    short: "pool bounded",
    // The test reads JobConcurrencyHighWaterMark after ProcessJobs returns.
    judge: (run) => (run.vars.hwm ?? 0) > K.floor.value && (run.vars.hwm ?? 0) <= K.poolMax.value,
  },
};

// RunJob as mockjobs.go writes it: current++, raise the high-water mark,
// sleep JobLatency, current--. `current` lives in `vars`; the high-water mark
// node moves through `inc`, so it adds up whatever the order of the goroutines.
function* runJob(vars: Self["vars"], at: string | undefined): Generator<Op, void, unknown> {
  vars.current = (vars.current ?? 0) + 1;
  const raised = Math.max(0, vars.current - (vars.hwm ?? 0));
  vars.hwm = (vars.hwm ?? 0) + raised;
  const o = at === undefined ? {} : { at };
  if (raised > 0) yield inc("highWaterMark", raised, o);
  yield work(ROUND, "RunJob", o);
  vars.current -= 1;
}

const highWaterMark = fact({ label: "hwm", pos: [1, 1], value: 0, limit: K.poolMax.value });

// The pool with `workers` goroutines. `lines` turns on the `at` hints for the
// inside scene's code panel.
function pool(workers: number, lines: boolean): Pick<Model, "nodes"> {
  const at = (text: string): { at: string } | Record<string, never> => (lines ? { at: text } : {});
  return {
    nodes: {
      feeder: goroutine({
        label: "jobs",
        pos: [0, 0],
        spawned: true,
        program: function* () {
          for (let i = 0; i < N; i++) yield send("jobCh", i, at("jobCh <- j"));
          yield close("jobCh", at("close(jobCh)"));
        },
      }),
      jobCh: channel({ label: "jobs chan", pos: [1, 0], cap: 0 }),
      worker: goroutine({
        label: "worker",
        pos: [2, 0],
        count: workers,
        base: 1,
        spawned: true,
        program: function* ({ vars }) {
          yield* range(
            "jobCh",
            function* (r) {
              yield* runJob(vars, lines ? "RunJob(j)" : undefined);
              yield send("resultCh", r.tok!, at("resultCh <- Result"));
            },
            at("range jobCh"),
          );
          yield done("wg", at("defer wg.Done()"));
        },
      }),
      resultCh: channel({ label: "results chan", pos: [3, 0], cap: 0 }),
      caller: goroutine({
        label: "ProcessJobs",
        pos: [4, 0],
        main: true,
        program: function* () {
          yield add("wg", workers, at("wg.Add(numWorkers)"));
          yield go("worker[*]", at("go func() {"));
          yield go("feeder", at("go func() {"));
          yield go("closer", at("go func() {"));
          yield* range("resultCh", function* () {}, at("range resultCh"));
        },
      }),
      wg: waitgroup({ label: "exits", pos: [2, 1] }),
      closer: goroutine({
        label: "close",
        pos: [3, 1],
        spawned: true,
        program: function* () {
          yield wait("wg", at("wg.Wait()"));
          yield close("resultCh", at("close(resultCh)"));
        },
      }),
      highWaterMark,
    },
  };
}

const SOLUTION = `
@caller func ProcessJobs(jobs []Job) []Result {
@caller 	jobCh := make(chan Job)
@caller 	resultCh := make(chan Result)
@caller
@caller 	var wg sync.WaitGroup
@caller 	wg.Add(numWorkers)
@caller 	for i := 0; i < numWorkers; i++ {
@caller 		go func() {
@worker 			defer wg.Done()
@worker 			for j := range jobCh {
@worker 				err := RunJob(j)
@worker 				resultCh <- Result{JobID: j.ID, Err: err}
@worker 			}
@caller 		}()
@caller 	}
@caller
@caller 	go func() {
@feeder 		for _, j := range jobs {
@feeder 			jobCh <- j
@feeder 		}
@feeder 		close(jobCh)
@caller 	}()
@caller
@caller 	go func() {
@closer 		wg.Wait()
@closer 		close(resultCh)
@caller 	}()
@caller
@caller 	results := make([]Result, 0, len(jobs))
@caller 	for r := range resultCh {
@caller 		results = append(results, r)
@caller 	}
@caller 	return results
@caller }`;

function goal(P: Params): Model {
  const workers = Number(P.workers);
  const hwm = Math.min(workers, N);
  const t = Math.ceil(N / workers) * ROUND;
  const ok = hwm > K.floor.value && hwm <= K.poolMax.value;
  const insight =
    workers <= K.floor.value
      ? `One worker is a pool in name only. The ${N} jobs still run one at a time. The high-water mark stays at ${hwm}, and the run takes ${t} ms. The test needs more than ${K.floor.value}.`
      : workers > K.poolMax.value
        ? `${workers} workers means one goroutine per job. Every job runs at once, and the high-water mark reaches ${hwm}. That is past ${K.poolMax.value}, which the test allows. A pool exists to keep this number small.`
        : `The workers take jobs as each one frees up. At most ${workers} jobs run at once, however many jobs exist. The ${N} jobs finish at ${t} ms.`;
  return {
    ...pool(workers, false),
    insight,
    stops:
      ok
        ? [
            { when: { op: "close", node: "jobCh" }, say: `All ${N} jobs are sent, and the jobs channel closes. Each worker ends its loop when no job is left.` },
            { when: { op: "close", node: "resultCh" }, say: "Every worker is done, so the coordinating goroutine closes the results channel. The caller's loop ends." },
          ]
        : [],
    tests,
    clock: { unit: "ms" },
    expect: { outcome: "ok", t, tests: { bounded: ok ? "pass" : "fail" } },
  };
}

export default defineViz({
  schema: 3,
  exercise: "11-worker-pool",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:be8fe46d", goal: "fnv1a:be8fe46d" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `ProcessJobs runs ${N} jobs one at a time on one goroutine. One RunJob is in flight, and the high-water mark stays at 1.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "ProcessJobs",
            pos: [0, 0],
            main: true,
            program: function* ({ vars }) {
              for (let i = 0; i < N; i++) yield* runJob(vars, "RunJob(j)");
            },
          }),
          highWaterMark: fact({ label: "hwm", pos: [1, 0], value: 0, limit: K.poolMax.value }),
        },
        insight: `Each RunJob waits for the one before it. Two jobs are never in flight, so the high-water mark stays at 1. The ${N} jobs take ${N * ROUND} ms. The test needs more than ${K.floor.value}.`,
        stops: [
          {
            when: { op: "work", nth: 2 },
            say: `Job 1 starts only now, ${ROUND} ms after job 0 began. The high-water mark is still 1.`,
          },
        ],
        tests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@caller func ProcessJobs(jobs []Job) []Result {
@caller 	results := make([]Result, 0, len(jobs))
@caller 	for _, j := range jobs {
@caller 		err := RunJob(j)
@caller 		results = append(results, Result{JobID: j.ID, Err: err})
@caller 	}
@caller 	return results
@caller }`,
        },
        expect: { outcome: "ok", t: N * ROUND, tests: { bounded: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: "A few workers take jobs from one channel and send results to another. The high-water mark follows the worker count, not the job count.",
      knobs: [{ key: "workers", label: "workers", options: [K.floor.value, K.workers.value, K.poolMax.value, N], value: K.workers.value }],
      model: goal,
    },
    {
      id: "closes",
      chip: "Closes",
      tier: "inside",
      summary: "The pool has two closes. close(jobCh) ends the workers. close(resultCh), after wg.Wait(), ends the caller's range loop.",
      model: {
        ...pool(K.workers.value, true),
        insight: "The feeder closes jobCh after the last job. Each worker's range loop ends, and each worker calls Done. When the count reaches 0, the closer closes resultCh. Only then does the caller's range loop end.",
        stops: [
          { when: { op: "close", node: "jobCh" }, say: "close(jobCh) means no job is left. Each worker ends its range loop after its current job." },
          { when: { op: "close", node: "resultCh" }, say: "close(resultCh) runs on another goroutine. The caller is still draining resultCh, so it cannot wait here." },
        ],
        tests,
        clock: { unit: "ms" },
        code: { file: "solution", text: SOLUTION },
        expect: { outcome: "ok", t: Math.ceil(N / K.workers.value) * ROUND, tests: { bounded: "pass" } },
      },
    },
  ],
});
