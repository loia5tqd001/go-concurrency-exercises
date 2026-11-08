// 24 is a scheduling-order problem. A FIFO channel freezes the position of
// every submitted job, so an urgent job cannot move ahead of an existing
// backlog. The fixed scheduler chooses again whenever the worker is free,
// using priority first and submission order to break ties.
//
// The engine has no sync.Cond primitive. The Wake scene therefore uses the
// README's explicitly allowed small signaling channel. The queue scenes model
// the observed queue length and selected job rather than drawing the heap's
// private backing array.

import {
  channel,
  defineViz,
  exit,
  fact,
  fail,
  go,
  goroutine,
  inc,
  lock,
  mutex,
  notify,
  pass,
  put,
  recv,
  send,
  set,
  SIGNAL,
  sleep,
  slice,
  unlock,
  work,
} from "../engine/ops.ts";
import type { Model, Self, TestDef } from "../engine/model.ts";

const K = {
  latency: {
    value: 20,
    file: "check_test.go",
    text: "const jobLatency = 20 * time.Millisecond",
  },
  queueCap: {
    value: 100,
    file: "main.go",
    text: "jobs: make(chan Job, 100)",
  },
  urgentAt: {
    value: 5,
    file: "check_test.go",
    text: "time.Sleep(5 * time.Millisecond) // let the worker pick job 1 up",
  },
  jobs: {
    value: 7,
    file: "check_test.go",
    text: "got := readCompletions(t, sched, 7)",
  },
  lowMax: {
    value: 6,
    file: "check_test.go",
    text: "for id := 2; id <= 6; id++ {",
  },
  urgentID: {
    value: 7,
    file: "check_test.go",
    text: "sched.Submit(Job{ID: 7, Priority: 10})",
  },
  lowPriority: {
    value: 1,
    file: "check_test.go",
    text: "sched.Submit(Job{ID: 1, Priority: 1})",
  },
  urgentPriority: {
    value: 10,
    file: "check_test.go",
    text: "sched.Submit(Job{ID: 7, Priority: 10})",
  },
  tiePriority: {
    value: 5,
    file: "check_test.go",
    text: "sched.Submit(Job{ID: 1, Priority: 5})",
  },
  tieJobs: {
    value: 6,
    file: "check_test.go",
    text: "got := readCompletions(t, sched, 6)",
  },
} as const;

const N = K.jobs.value;
const TIES = K.tieJobs.value;
const ROUND = K.latency.value;

const tests = {
  urgent: {
    name: "TestSchedulerPrioritizesUrgentJobs",
    short: "urgent job next",
  },
  ties: {
    name: "TestSchedulerTiesBrokenByArrivalOrder",
    short: "priority order",
  },
} satisfies Record<string, TestDef>;

const completed = (size: number, pos: readonly [number, number]) =>
  slice({ label: "completed", pos, size });

// The urgent-job test. Job 1 is already running after its submission. Jobs
// 2-6 queue at priority 1, then job 7 arrives at priority 10.
function urgentTest(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "test",
    pos: [0, 1],
    main: true,
    program: function* () {
      yield go("worker");
      yield send("jobs", 1);
      yield sleep(K.urgentAt.value);
      for (let id = 2; id <= K.lowMax.value; id++) {
        yield send("jobs", id);
      }
      yield send("jobs", K.urgentID.value);

      let urgentIndex = -1;
      for (let i = 0; i < N; i++) {
        const r = yield recv("done");
        yield set("completed", i + 1);
        if (Number(r.v) === K.urgentID.value) urgentIndex = i;
      }
      if (urgentIndex <= 1) yield pass("urgent");
      else yield fail("urgent");
      yield exit("test process ends");
    },
  });
}

function fifoWorker(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "worker",
    pos: [1, 2],
    spawned: true,
    program: function* () {
      // The committed worker ranges forever. The model ends after the seven
      // completions the named test reads; the next range receive is omitted.
      for (let i = 0; i < N; i++) {
        const r = yield recv("jobs", { at: "for job := range s.jobs" });
        yield work(ROUND, `job ${String(r.v)}`, { at: "time.Sleep(20 * time.Millisecond) // simulated work" });
        yield send("done", r.tok!, { at: "s.done <- job.ID" });
      }
      yield recv("jobs", { at: "for job := range s.jobs" });
    },
  });
}

// The fixed worker selects in priority order. This run has one urgent job,
// so the only legal completion position for it after job 1 is index 1.
function fixedUrgentWorker(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "worker",
    pos: [2, 1],
    spawned: true,
    program: function* ({ vars }: Self) {
      yield set("priority", K.lowPriority.value);
      yield work(ROUND, "job 1", { at: "time.Sleep(20 * time.Millisecond)" });
      yield send("done", 1, { at: "s.done <- qj.job.ID" });

      const order = [7, 2, 3, 4, 5, 6];
      for (const id of order) {
        yield lock("queueMu", { at: "s.mu.Lock()" });
        yield inc("queue", -1, { at: "heap.Pop(&s.queue)" });
        vars.priority = id === K.urgentID.value ? K.urgentPriority.value : K.lowPriority.value;
        yield unlock("queueMu", { at: "s.mu.Unlock()" });
        yield set("priority", vars.priority);
        yield work(ROUND, `job ${id}`, { at: "time.Sleep(20 * time.Millisecond)" });
        yield send("done", id, { at: "s.done <- qj.job.ID" });
      }
      yield recv("signal");
    },
  });
}

// The same submissions as the test, but queue length is the observable state
// of the internal priority queue because container/heap has no graph node.
function fixedUrgentTest(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "test",
    pos: [0, 1],
    main: true,
    program: function* () {
      yield go("worker");
      yield sleep(K.urgentAt.value);
      for (let id = 2; id <= K.lowMax.value; id++) {
        yield lock("queueMu", { at: "s.mu.Lock()" });
        yield inc("queue", 1, { at: "heap.Push(&s.queue" });
        yield unlock("queueMu", { at: "s.mu.Unlock()" });
      }
      yield lock("queueMu", { at: "s.mu.Lock()" });
      yield inc("queue", 1, { at: "heap.Push(&s.queue" });
      yield unlock("queueMu", { at: "s.mu.Unlock()" });

      let urgentIndex = -1;
      for (let i = 0; i < N; i++) {
        const r = yield recv("done");
        yield put("completed", i, r.tok!);
        if (Number(r.v) === K.urgentID.value) urgentIndex = i;
      }
      if (urgentIndex <= 1) yield pass("urgent");
      else yield fail("urgent");
      yield exit("test process ends");
    },
  });
}

function tiesTest(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "test",
    pos: [0, 1],
    main: true,
    program: function* () {
      yield go("worker");
      yield sleep(K.urgentAt.value);
      for (let id = 2; id <= TIES; id++) {
        yield lock("queueMu");
        yield inc("queue", 1);
        yield set("seq", id - 1);
        yield unlock("queueMu");
      }

      let ordered = true;
      for (let i = 0; i < TIES; i++) {
        const r = yield recv("done");
        yield put("completed", i, r.tok!);
        if (Number(r.v) !== i + 1) ordered = false;
      }
      if (ordered) yield pass("ties");
      else yield fail("ties");
      yield exit("test process ends");
    },
  });
}

function tiesWorker(): ReturnType<typeof goroutine> {
  return goroutine({
    label: "worker",
    pos: [2, 1],
    spawned: true,
    program: function* () {
      yield set("priority", K.tiePriority.value);
      yield work(ROUND, "job 1");
      yield send("done", 1);
      for (let id = 2; id <= TIES; id++) {
        yield lock("queueMu");
        yield inc("queue", -1);
        yield set("seq", id - 1, { at: "h[i].seq < h[j].seq" });
        yield unlock("queueMu");
        yield work(ROUND, `job ${id}`);
        yield send("done", id);
      }
      yield recv("signal");
    },
  });
}

function wakeModel(): Model {
  return {
    nodes: {
      test: goroutine({
        label: "test",
        pos: [0, 0],
        main: true,
        program: function* () {
          yield go("worker", { at: "go s.worker()" });
          // A zero-duration yield selects the run where NewScheduler returns
          // before Submit, so the worker is already parked. It adds no time.
          yield sleep(0);
          yield lock("queueMu", { at: "s.mu.Lock()" });
          yield inc("queue", 1, { at: "heap.Push(&s.queue" });
          yield unlock("queueMu", { at: "s.mu.Unlock()" });
          yield notify("signal", SIGNAL, { at: "s.cond.Signal()" });
          const r = yield recv("done", { at: "case id := <-sched.Completed():" });
          yield put("completed", 0, r.tok!);
          yield exit("test process ends");
        },
      }),
      signal: channel({ label: "wake", pos: [1, 0], cap: 1 }),
      queueMu: mutex({ label: "mutex", pos: [1, 1] }),
      worker: goroutine({
        label: "worker",
        pos: [2, 0],
        spawned: true,
        program: function* () {
          yield lock("queueMu", { at: "s.mu.Lock()" });
          yield unlock("queueMu", { at: "s.cond.Wait()" });
          yield recv("signal", { at: "s.cond.Wait()" });
          yield lock("queueMu", { at: "s.mu.Lock()" });
          yield inc("queue", -1, { at: "heap.Pop(&s.queue)" });
          yield unlock("queueMu", { at: "s.mu.Unlock()" });
          yield work(ROUND, "job 1", { at: "time.Sleep(20 * time.Millisecond)" });
          yield send("done", 1, { at: "s.done <- qj.job.ID" });
          yield recv("signal", { at: "s.cond.Wait()" });
        },
      }),
      queue: fact({ label: "queue", pos: [2, 1], value: 0, unit: "jobs" }),
      done: channel({ label: "done", pos: [3, 0], cap: K.queueCap.value }),
      completed: completed(1, [3, 1]),
    },
    insight:
      "The queue is empty. The worker releases the mutex and waits on signal. Submit locks, adds the job, unlocks, and signals. The worker wakes, rechecks the queue, and starts the job.",
    stops: [
      { when: { op: "block", g: "worker" }, say: "The queue is empty. The worker waits on signal. Submit can now take the mutex." },
      { when: { op: "notify", g: "test" }, say: "Submit added the job and released the mutex. The signal wakes the waiting worker." },
      { when: { op: "work", g: "worker" }, say: "The worker checks again. It finds the job and starts it." },
    ],
    expect: { outcome: "exit", t: ROUND },
  };
}

export default defineViz({
  schema: 3,
  exercise: "24-priority-worker-pool",
  diagrams: { today: "fnv1a:a5c6ee56", goal: "fnv1a:a5c6ee56" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary:
        "Jobs enter one FIFO channel in arrival order. Job 7 has priority 10. It still sits behind jobs 2-6 and finishes last.",
      model: {
        nodes: {
          test: urgentTest(),
          jobs: channel({ label: "jobs", pos: [1, 0], cap: K.queueCap.value }),
          worker: fifoWorker(),
          done: channel({ label: "done", pos: [2, 1], cap: K.queueCap.value }),
          completed: fact({ label: "completed", pos: [3, 1], value: 0 }),
        },
        insight:
          "A channel keeps send order. Job 7 has priority 10. That number cannot move it ahead of jobs 2-6. The worker finishes 1 through 7 in order.",
        stops: [
          { when: { op: "send", g: "test", node: "jobs", nth: 6 }, say: "Job 7 (priority 10) enters the queue. It is fixed behind jobs 2-6." },
          { when: { op: "fail", g: "test" }, say: "Job 7 finishes last, behind every low-priority job. The urgent-job test fails." },
        ],
        tests: { urgent: tests.urgent },
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@worker func (s *Scheduler) worker() {
@worker 	for job := range s.jobs {
@worker 		time.Sleep(20 * time.Millisecond) // simulated work
@worker 		s.done <- job.ID
@worker 	}
@worker }

@test func (s *Scheduler) Submit(job Job) {
@test 	s.jobs <- job
@test }`,
        },
        expect: { outcome: "exit", t: N * ROUND, tests: { urgent: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary:
        "The worker finishes job 1 first. It then takes job 7 before the priority 1 backlog. The order is 1, 7, 2, 3, 4, 5, 6.",
      model: {
        nodes: {
          test: fixedUrgentTest(),
          queue: fact({ label: "queue", pos: [1, 0], value: 0, unit: "jobs" }),
          queueMu: mutex({ label: "mutex", pos: [1, 1] }),
          worker: fixedUrgentWorker(),
          priority: fact({ label: "priority", pos: [2, 0], value: K.lowPriority.value }),
          done: channel({ label: "done", pos: [3, 1], cap: K.queueCap.value }),
          completed: completed(N, [3, 2]),
          signal: channel({ label: "wake", pos: [2, 2], cap: 0 }),
        },
        insight:
          "Job 7 does not interrupt the running job. At the next pick, it wins on priority. Jobs 2-6 keep their arrival order.",
        stops: [
          { when: { op: "set", g: "worker", node: "priority", nth: 2 }, say: "Job 1 has finished. Job 7 has the highest priority, so it is picked next." },
          { when: { op: "send", g: "worker", node: "done", nth: 2 }, say: "The order is 1, 7, 2, 3, 4, 5, 6. Job 7 is second, so the test passes." },
        ],
        tests: { urgent: tests.urgent },
        clock: { unit: "ms" },
        expect: { outcome: "exit", t: N * ROUND, tests: { urgent: "pass" } },
      },
    },
    {
      id: "ties",
      chip: "Ties",
      tier: "inside",
      summary:
        "Every queued job has priority 5. Priority cannot separate them. The scheduler uses submission order, so completion stays 1-6.",
      model: {
        nodes: {
          test: tiesTest(),
          queue: fact({ label: "queue", pos: [1, 0], value: 0, unit: "jobs" }),
          queueMu: mutex({ label: "mutex", pos: [1, 1] }),
          worker: tiesWorker(),
          priority: fact({ label: "priority", pos: [2, 0], value: K.tiePriority.value }),
          seq: fact({ label: "seq", pos: [3, 0], value: 0 }),
          done: channel({ label: "done", pos: [3, 1], cap: K.queueCap.value }),
          completed: completed(TIES, [3, 2]),
          signal: channel({ label: "wake", pos: [2, 2], cap: 0 }),
        },
        insight:
          "Equal priorities use seq as the tie-break. The earliest sequence is smallest. The heap pops priority 5 jobs in submission order. The test passes.",
        stops: [
          { when: { op: "set", g: "worker", node: "seq", nth: 1 }, say: "The priorities tie, so seq decides. Job 2 has the earliest remaining sequence." },
          { when: { op: "pass", g: "test" }, say: "The completed list is 1, 2, 3, 4, 5, 6. Equal-priority jobs keep submission order." },
        ],
        tests: { ties: tests.ties },
        clock: { unit: "ms" },
        code: {
          file: "solution",
          text: `
@worker func (h jobHeap) Less(i, j int) bool {
@worker 	if h[i].job.Priority != h[j].job.Priority {
@worker 		return h[i].job.Priority > h[j].job.Priority // max-heap on Priority
@worker 	}
@worker 	return h[i].seq < h[j].seq // FIFO among ties
@worker }`,
        },
        expect: { outcome: "exit", t: TIES * ROUND, tests: { ties: "pass" } },
      },
    },
    {
      id: "wake",
      chip: "Wake",
      tier: "inside",
      summary:
        "The queue is empty. The worker waits on signal with the mutex released. Submit adds work and wakes it. The job runs.",
      model: wakeModel(),
    },
  ],
});
