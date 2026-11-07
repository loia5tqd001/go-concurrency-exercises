// 25 is a completion-contract problem. Closing jobs only stops future receives;
// it does not wait for a worker already inside process. The scaffold closes
// done before Start returns. The fixed Start waits for all four workers, then
// closes done. The deterministic test blocks process on proceed and proves that
// done stays open until that in-flight call is released.

import {
  add,
  channel,
  close,
  defineViz,
  done,
  fact,
  fail,
  go,
  goroutine,
  inc,
  onRecv,
  pass,
  range,
  recv,
  select,
  send,
  start,
  timer,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { TestDef } from "../engine/model.ts";

const K = {
  workers: { value: 4, file: "main.go", text: "const numWorkers = 4" },
  jobs: { value: 20, file: "check_test.go", text: "const numJobs = 20" },
  processMs: { value: 5, file: "check_test.go", text: "time.Sleep(5 * time.Millisecond)" },
  blockedWaitMs: { value: 200, file: "check_test.go", text: "time.After(200 * time.Millisecond)" },
} as const;

const W = K.workers.value;
const N = K.jobs.value;

const tests: Record<string, TestDef> = {
  every: {
    name: "TestStartProcessesEveryJob",
    short: "all processed",
  },
  inflight: {
    name: "TestDoneWaitsForInFlightProcessCall",
    short: "blocked process",
  },
};

function producer(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "producer",
    pos: [0, 0],
    spawned: true,
    tone: 1,
    program: function* () {
      for (let item = 0; item < N; item++) {
        yield send("jobs", item);
      }
      yield close("jobs");
    },
  });
}

function workers(withDone: boolean): ReturnType<typeof goroutine> {
  return goroutine({
    label: "worker",
    pos: [2, 0],
    count: W,
    base: 1,
    spawned: true,
    program: function* ({ vars }) {
      yield* range(
        "jobs",
        function* () {
          yield work(K.processMs.value, "process", { at: "process(item)" });
          vars.processed = (vars.processed ?? 0) + 1;
          yield inc("processed");
        },
        { at: "for item := range jobs" },
      );
      if (withDone) yield done("workers", { at: "wg.Done()" });
    },
  });
}

function scanner(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "helper",
    pos: [0, 1],
    spawned: true,
    program: function* () {
      for (let i = 0; i < W; i++) {
        yield go(`worker[${i}]`);
      }
      yield close("done", { at: "close(done)" });
      yield send("result", "ch");
    },
  });
}

function starter(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "helper",
    pos: [0, 1],
    spawned: true,
    program: function* () {
      for (let i = 0; i < W; i++) {
        yield add("workers", 1, { at: "wg.Add(1)" });
        yield go(`worker[${i}]`);
      }
      yield go("doneWait");
      yield send("result", "ch");
    },
  });
}

const doneWait = goroutine({
  label: "wait",
  pos: [3, 1],
  spawned: true,
  program: function* () {
    yield wait("workers", { at: "wg.Wait()" });
    yield close("done", { at: "close(done)" });
  },
});

function everyTest(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "test",
    pos: [0, 2],
    main: true,
    program: function* ({ vars }) {
      yield go("producer");
      yield go("helper");
      yield recv("result");
      yield recv("done");
      if ((vars.processed ?? 0) === N) yield pass("every");
      else yield fail("every");
    },
  });
}

const today = {
  nodes: {
    test: everyTest(),
    producer: producer(),
    helper: scanner(),
    worker: workers(false),
    result: channel({ label: "result", pos: [1, 1], cap: 1 }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    processed: fact({ label: "processed", pos: [2, 2], value: 0, limit: N }),
    done: channel({ label: "done", pos: [3, 1], cap: 0 }),
  },
  insight:
    "done closes before Start returns. The test may receive it while workers are still processing jobs, so processed does not protect downstream cleanup.",
  stops: [
    {
      when: { op: "close", node: "done" },
      say: "done closes immediately, with no relationship to the workers or their process calls.",
    },
  ],
  tests: { every: tests.every! },
  code: {
    file: "main.go",
    text: `
@helper func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
@helper 	for i := 0; i < numWorkers; i++ {
@helper 		go func() {
@worker 			for item := range jobs {
@worker 				process(item)
@worker 			}
@helper 		}()
@helper 	}
…
@helper 	done := make(chan struct{})
@helper 	close(done)
@helper 	return done
@helper }`,
  },
  expect: { outcome: "ok", tests: { every: "fail" } },
} as const;

const goal = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 1],
      main: true,
      program: function* ({ vars }) {
        yield go("producer");
        yield go("worker[*]");
        yield recv("done");
        if ((vars.processed ?? 0) === N) yield pass("every");
        else yield fail("every");
      },
    }),
    producer: producer(),
    worker: goroutine({
      label: "worker",
      pos: [2, 0],
      count: W,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range(
          "jobs",
          function* () {
            yield work(K.processMs.value, "process", { at: "process(item)" });
            vars.processed = (vars.processed ?? 0) + 1;
            yield inc("processed");
          },
          { at: "for item := range jobs" },
        );
        vars.finished = (vars.finished ?? 0) + 1;
        if (vars.finished === W) yield close("done");
      },
    }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    processed: fact({ label: "processed", pos: [2, 2], value: 0, limit: N }),
    done: channel({ label: "done", pos: [3, 1], cap: 0 }),
  },
  insight:
    "Closing jobs stops new receives, but workers already inside process keep running. The test observes done only after all four returns, when processed is 20.",
  stops: [
    {
      when: { op: "close", node: "jobs" },
      say: "The producer has no more work, but some workers may still be inside process. done stays open.",
    },
    {
      when: { op: "close", node: "done" },
      say: "The last worker has returned from process. Only now does the test observe done close.",
    },
  ],
  tests: { every: tests.every! },
  expect: { outcome: "ok", tests: { every: "pass" } },
} as const;

const stages = {
  nodes: {
    test: everyTest(),
    producer: producer(),
    helper: starter(),
    worker: workers(true),
    workers: waitgroup({ label: "workers", pos: [3, 0] }),
    doneWait,
    result: channel({ label: "result", pos: [1, 1], cap: 1 }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    processed: fact({ label: "processed", pos: [2, 2], value: 0, limit: N }),
    done: channel({ label: "done", pos: [4, 1], cap: 0 }),
  },
  insight:
    `jobs closing and done closing are separate events. At the first, workers may still be in process. At the second, all ${W} have returned.`,
  stops: [
    {
      when: { op: "wait", node: "workers" },
      say: "The background waiter blocks on the four workers. Start has already returned its done channel.",
    },
    {
      when: { op: "close", node: "jobs" },
      say: "The range loop ends only after the current process call returns; closing jobs does not interrupt that call.",
    },
    {
      when: { op: "close", node: "done" },
      say: "All four calls to Done have happened. The caller may now tear down process output.",
    },
  ],
  tests: { every: tests.every! },
  code: {
    file: "solution",
    text: `
@helper func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
@helper 	var wg sync.WaitGroup
@helper
@helper 	for i := 0; i < numWorkers; i++ {
@helper 		wg.Add(1)
@helper 		go func() {
@worker 			defer wg.Done()
@worker 			for item := range jobs {
@worker 				process(item)
@worker 			}
@helper 		}()
@helper 	}
@helper
@helper 	done := make(chan struct{})
@doneWait 	go func() {
@doneWait 		wg.Wait()
@doneWait 		close(done)
@doneWait 	}()
@helper
@helper 	return done
@helper }`,
  },
  expect: { outcome: "ok", tests: { every: "pass" } },
} as const;

const blocked = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 2],
      main: true,
      program: function* () {
        yield go("helper");
        yield recv("result");
        yield send("jobs", 0);
        yield recv("started");
        yield close("jobs");
        yield start("timeout");
        const waited = yield select([onRecv("done"), onRecv("timeout")]);
        if (waited.i === 0) {
          yield fail("inflight");
          return;
        }
        yield close("proceed");
        yield recv("done");
        yield pass("inflight");
      },
    }),
    helper: starter(),
    worker: goroutine({
      label: "worker",
      pos: [2, 0],
      count: W,
      base: 1,
      spawned: true,
      program: function* () {
        yield* range(
          "jobs",
          function* () {
            yield close("started");
            yield recv("proceed");
          },
          { at: "for item := range jobs" },
        );
        yield done("workers", { at: "wg.Done()" });
      },
    }),
    workers: waitgroup({ label: "workers", pos: [3, 0] }),
    doneWait,
    result: channel({ label: "result", pos: [1, 1], cap: 1 }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    started: channel({ label: "started", pos: [2, 1], cap: 0 }),
    proceed: channel({ label: "proceed", pos: [3, 2], cap: 0 }),
    done: channel({ label: "done", pos: [4, 1], cap: 0 }),
    timeout: timer({ label: "timeout", pos: [1, 2], after: K.blockedWaitMs.value }),
  },
  insight:
    "The test closes jobs while one process call is parked on proceed. After 200 ms done is still open; only releasing process lets the last worker return.",
  stops: [
    {
      when: { op: "recv", g: "worker", node: "proceed" },
      say: "A worker is inside process. jobs is already closed, but this call is still in flight.",
    },
    {
      when: { op: "fire", node: "timeout" },
      say: "The test's 200 ms probe expires. done has stayed open, which is the required result.",
    },
    {
      when: { op: "close", node: "proceed" },
      say: "The process call returns, its worker exits the range loop, and the final Done lets done close.",
    },
  ],
  tests: { inflight: tests.inflight! },
  clock: { unit: "ms" },
  code: {
    file: "solution",
    text: `
@helper func Start(jobs <-chan int, process func(item int)) <-chan struct{} {
@helper 	var wg sync.WaitGroup
@helper
@helper 	for i := 0; i < numWorkers; i++ {
@helper 		wg.Add(1)
@helper 		go func() {
@worker 			defer wg.Done()
@worker 			for item := range jobs {
@worker 				process(item)
@worker 			}
@helper 		}()
@helper 	}
@helper
@helper 	done := make(chan struct{})
@doneWait 	go func() {
@doneWait 		wg.Wait()
@doneWait 		close(done)
@doneWait 	}()
@helper
@helper 	return done
@helper }`,
  },
  expect: { outcome: "ok", t: K.blockedWaitMs.value, tests: { inflight: "pass" } },
} as const;

export default defineViz({
  schema: 3,
  exercise: "25-graceful-multistage-shutdown",
  diagrams: { today: "fnv1a:3a3368af", goal: "fnv1a:3a3368af" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary:
        "The scaffold closes done before Start returns, so the test sees fewer than 20 completed process calls.",
      model: today,
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary:
        "done closes only after all four workers return and every submitted job has finished processing.",
      model: goal,
    },
    {
      id: "stages",
      chip: "Stages",
      tier: "inside",
      summary:
        "Closing jobs stops future work; the workers counter reaches zero only after every in-flight process call finishes.",
      model: stages,
    },
    {
      id: "blocked",
      chip: "Blocked",
      tier: "inside",
      summary:
        "The deterministic test keeps one process call blocked for 200 ms and verifies that done does not close.",
      model: blocked,
    },
  ],
});
