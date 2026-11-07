// 37 is one shutdown contract with two separate jobs: stop admitting work,
// then wait for the work already admitted. Today sends on jobs after Close
// has closed it. Goal shows the contract at README level. The inside scenes
// isolate admission, the drain, and the post-close rejection path.
//
// The visualisation engine models sync.Mutex, not sync.RWMutex. The Admit
// scene therefore shows the critical schedule with one Submit holding the
// read lock across its send; two readers holding it together cannot be shown
// without adding an engine primitive.

import {
  add,
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
  recv,
  range,
  send,
  set,
  unlock,
  wait,
  waitgroup,
} from "../engine/ops.ts";
import type { RunSummary, TestDef } from "../engine/model.ts";

const K = {
  workers3: { value: 3, file: "check_test.go", text: "p := NewPool(3)" },
  workers4: { value: 4, file: "check_test.go", text: "p := NewPool(4)" },
  jobs: { value: 20, file: "check_test.go", text: "const n = 20" },
  preClose: { value: 10, file: "check_test.go", text: "const preClose = 10" },
  postClose: { value: 50, file: "check_test.go", text: "const postCloseSubmitters = 50" },
  timeout: { value: 3, file: "check_test.go", text: "const closeTimeout = 3 * time.Second" },
} as const;

const WORKERS = K.workers3.value;
const RACE_WORKERS = K.workers4.value;
const PRECLOSE = K.preClose.value;
const POSTCLOSE = K.postClose.value;

const passed = (run: RunSummary, condition: boolean): boolean => run.outcome === "ok" && condition;

const tests: Record<string, TestDef> = {
  late: {
    name: "TestSubmitAfterCloseIsRejectedNotPanicked",
    short: "late submit",
    judge: (run) => passed(run, (run.vars.rejected ?? 0) === POSTCLOSE && (run.vars.ran ?? 0) === PRECLOSE),
  },
  drain: {
    name: "TestSubmitRunsAllJobsSequentially",
    short: "accepted ran",
    judge: (run) => passed(run, (run.vars.accepted ?? 0) === K.jobs.value && (run.vars.ran ?? 0) === K.jobs.value),
  },
  race: {
    name: "TestConcurrentSubmitDuringCloseNeverPanics",
    short: "submit/close",
    judge: (run) => passed(run, (run.vars.closed ?? 0) === 1 && (run.vars.ran ?? 0) === 1),
  },
};

// TestSubmitAfterCloseIsRejectedNotPanicked at the point where Close has
// already closed jobs and the next Submit reaches the closed channel.
// The engine has no recover operation, so the scene stops at the panic event
// and marks the test failed; it does not model the defer/recover continuing.
const today = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 0],
      main: true,
      program: function* ({ vars }) {
        yield go("worker[*]");
        for (let i = 0; i < PRECLOSE; i++) {
          yield send("jobs", i, { at: "p.jobs <- job" });
          vars.accepted = (vars.accepted ?? 0) + 1;
          yield inc("accepted", 1, { at: "return true" });
        }
        yield close("jobs", { at: "close(p.jobs)" });
        yield go("submit");
      },
    }),
    submit: goroutine({
      label: "Submit",
      pos: [1, 1],
      spawned: true,
      program: function* () {
        yield send("jobs", "job", { at: "p.jobs <- job" });
      },
    }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    worker: goroutine({
      label: "worker",
      pos: [2, 0],
      count: WORKERS,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range(
          "jobs",
          function* () {
            vars.ran = (vars.ran ?? 0) + 1;
            yield inc("ran", 1, { at: "job()" });
          },
          { at: "range p.jobs" },
        );
      },
    }),
    accepted: fact({ label: "accepted", pos: [0, 1], value: 0 }),
    ran: fact({ label: "ran", pos: [2, 1], value: 0 }),
  },
  insight:
    "Close has already run, but Submit still sends unconditionally. The recovered panic fails the test; it never has an accepted=false path.",
  stops: [
    { when: { op: "close", node: "jobs" }, say: "Close closes jobs without waiting for the accepted work that is still running." },
    { when: { op: "panic", g: "submit" }, say: "Submit reaches the closed channel. The test recovers the panic, reports it, and fails." },
  ],
  tests: { late: tests.late! },
  code: {
    file: "main.go",
    text: `
@test func (p *Pool) Submit(job func()) (accepted bool) {
@test 	p.jobs <- job
@test 	return true
@test }
…
@worker func (p *Pool) worker() {
@worker 	for job := range p.jobs {
@worker 		job()
@worker 	}
@worker }
…
@test func (p *Pool) Close() {
@test 	close(p.jobs)
@test }`,
  },
  expect: { outcome: "panic", tests: { late: "fail" } },
} as const;

// The README contract as one run: every accepted job is counted before its
// send, completed by a worker, and included in Close's drain. Only after that
// drain does jobs close and the post-Close burst return accepted=false.
const goal = {
  nodes: {
    caller: goroutine({
      label: "caller",
      pos: [0, 0],
      main: true,
      program: function* ({ vars }) {
        yield go("worker[*]");
        yield add("senders", 2);
        yield go("submit[*]");
        yield wait("senders");
        vars.closed = 1;
        yield set("closed", "closed");
        yield wait("jobsWG");
        yield close("jobs");
        vars.rejected = POSTCLOSE;
        yield inc("rejected", POSTCLOSE);
      },
    }),
    submit: goroutine({
      label: "Submit",
      pos: [1, 0],
      count: 2,
      base: 1,
      spawned: true,
      tone: 1,
      program: function* ({ i, vars }) {
        for (let n = 0; n < PRECLOSE / 2; n++) {
          yield add("jobsWG", 1);
          yield send("jobs", i * 5 + n);
          vars.accepted = (vars.accepted ?? 0) + 1;
          yield inc("accepted", 1);
        }
        yield done("senders");
      },
    }),
    jobs: channel({ label: "jobs", pos: [2, 0], cap: 0 }),
    worker: goroutine({
      label: "worker",
      pos: [3, 0],
      count: WORKERS,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range("jobs", function* () {
          vars.ran = (vars.ran ?? 0) + 1;
          yield inc("ran", 1);
          yield done("jobsWG");
        });
      },
    }),
    senders: waitgroup({ label: "WaitGroup", pos: [0, 1] }),
    jobsWG: waitgroup({ label: "wg", pos: [3, 1] }),
    accepted: fact({ label: "accepted", pos: [1, 2], value: 0 }),
    ran: fact({ label: "ran", pos: [4, 1], value: 0 }),
    rejected: fact({ label: "rejected", pos: [4, 2], value: 0 }),
    closed: fact({ label: "closed", pos: [2, 2], value: "open", states: ["open", "closed"] }),
  },
  insight:
    "Watch accepted and ran meet before jobs closes. The later Submit calls see closed and return false without running a job or touching jobs.",
  stops: [
    { when: { op: "set", node: "closed" }, say: "Close has stopped admission. The jobsWG drain still has to wait for every accepted job to finish." },
    { when: { op: "close", node: "jobs" }, say: "Only after the drain reaches zero does jobs close and the workers exit." },
    { when: { op: "inc", node: "rejected" }, say: `All ${POSTCLOSE} late Submit calls return accepted=false without sending.` },
  ],
  tests: { late: tests.late! },
  expect: { outcome: "ok", tests: { late: "pass" } },
} as const;

const SOLUTION_SUBMIT_SUBMIT = `
@submit func (p *Pool) Submit(job func()) (accepted bool) {
@submit 	p.mu.RLock()
@submit 	defer p.mu.RUnlock()
@submit
@submit 	if p.closed {
@submit 		return false
@submit 	}
@submit 	p.wg.Add(1)
@submit 	p.jobs <- job
@submit 	return true
@submit }`;

const SOLUTION_SUBMIT_TEST = `
@test func (p *Pool) Submit(job func()) (accepted bool) {
@test 	p.mu.RLock()
@test 	defer p.mu.RUnlock()
@test
@test 	if p.closed {
@test 		return false
@test 	}
@test 	p.wg.Add(1)
@test 	p.jobs <- job
@test 	return true
@test }`;

const SOLUTION_CLOSE_CLOSER = `
@closer func (p *Pool) Close() {
@closer 	p.mu.Lock()
@closer 	p.closed = true
@closer 	p.mu.Unlock()
@closer
@closer 	p.wg.Wait()
@closer 	close(p.jobs)
@closer }`;

const SOLUTION_CLOSE_TEST = `
@test func (p *Pool) Close() {
@test 	p.mu.Lock()
@test 	p.closed = true
@test 	p.mu.Unlock()
@test
@test 	p.wg.Wait()
@test 	close(p.jobs)
@test }`;

const SOLUTION_WORKER = `
@worker func (p *Pool) worker() {
@worker 	for job := range p.jobs {
@worker 		job()
@worker 		p.wg.Done()
@worker 	}
@worker }`;

// The engine's mutex models the one-reviewer case of RWMutex: this Submit
// holds its read lock across the send, so Close's write lock cannot pass it.
const admit = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 0],
      main: true,
      program: function* () {
        // NewPool starts the workers before any caller can Submit.
        yield go("worker[*]");
        yield go("submit");
        yield recv("closeDone");
      },
    }),
    submit: goroutine({
      label: "Submit",
      pos: [0, 1],
      spawned: true,
      tone: 1,
      program: function* () {
        yield lock("mu", { at: "p.mu.RLock()" });
        yield add("wg", 1, { at: "p.wg.Add(1)" });
        yield go("closer");
        yield send("jobs", "job", { at: "p.jobs <- job" });
        yield unlock("mu", { at: "defer p.mu.RUnlock()" });
      },
    }),
    closer: goroutine({
      label: "closer",
      pos: [2, 1],
      spawned: true,
      program: function* ({ vars }) {
        yield lock("mu", { at: "p.mu.Lock()" });
        yield set("closed", "closed", { at: "p.closed = true" });
        vars.closed = 1;
        yield unlock("mu", { at: "p.mu.Unlock()" });
        yield wait("wg", { at: "p.wg.Wait()" });
        yield close("jobs", { at: "close(p.jobs)" });
        yield close("closeDone");
      },
    }),
    jobs: channel({ label: "jobs", pos: [2, 0], cap: 0 }),
    worker: goroutine({
      label: "worker",
      pos: [3, 0],
      count: RACE_WORKERS,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range(
          "jobs",
          function* () {
            vars.ran = (vars.ran ?? 0) + 1;
            yield inc("ran", 1, { at: "job()" });
            yield done("wg", { at: "p.wg.Done()" });
          },
          { at: "range p.jobs" },
        );
      },
    }),
    mu: mutex({ label: "mu", pos: [1, 1] }),
    wg: waitgroup({ label: "wg", pos: [3, 1] }),
    closed: fact({ label: "closed", pos: [1, 2], value: "open", states: ["open", "closed"] }),
    ran: fact({ label: "ran", pos: [4, 1], value: 0 }),
    closeDone: channel({ label: "closeDone", pos: [4, 2], cap: 0 }),
  },
  insight:
    "Submit keeps the admission lock through the send. Close can take the write lock only after Submit releases the read lock; then it marks the pool closed.",
  stops: [
    { when: { op: "lock", g: "submit", node: "mu" }, say: "Submit takes the read lock before checking the flag or adding the job." },
    { when: { op: "lock", g: "closer", node: "mu" }, say: "Close reaches the write lock only after Submit releases its read lock; then it can set closed." },
    { when: { op: "wait", g: "closer", node: "wg" }, say: "Admission has stopped. Close now waits for the accepted job to finish." },
  ],
  tests: { race: tests.race! },
  code: {
    file: "solution",
    text: `${SOLUTION_SUBMIT_SUBMIT}
…
${SOLUTION_CLOSE_CLOSER}
…
${SOLUTION_WORKER}`,
  },
  expect: { outcome: "ok", tests: { race: "pass" } },
} as const;

// TestSubmitRunsAllJobsSequentially: 20 accepted jobs, then Close waits on
// the same WaitGroup before it closes jobs and lets the workers return.
const drain = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 0],
      main: true,
      program: function* ({ vars }) {
        yield go("worker[*]");
        for (let i = 0; i < K.jobs.value; i++) {
          yield add("wg", 1, { at: "p.wg.Add(1)" });
          yield send("jobs", i, { at: "p.jobs <- job" });
          vars.accepted = (vars.accepted ?? 0) + 1;
          yield inc("accepted", 1, { at: "return true" });
        }
        yield set("closed", "closed", { at: "p.closed = true" });
        yield wait("wg", { at: "p.wg.Wait()" });
        yield close("jobs", { at: "close(p.jobs)" });
      },
    }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    worker: goroutine({
      label: "worker",
      pos: [2, 0],
      count: WORKERS,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range(
          "jobs",
          function* () {
            vars.ran = (vars.ran ?? 0) + 1;
            yield inc("ran", 1, { at: "job()" });
            yield done("wg", { at: "p.wg.Done()" });
          },
          { at: "range p.jobs" },
        );
      },
    }),
    wg: waitgroup({ label: "wg", pos: [1, 1] }),
    accepted: fact({ label: "accepted", pos: [0, 1], value: 0 }),
    ran: fact({ label: "ran", pos: [3, 0], value: 0 }),
    closed: fact({ label: "closed", pos: [2, 1], value: "open", states: ["open", "closed"] }),
  },
  insight: `Twenty Add calls pair with twenty Done calls. Close changes wg from ${K.jobs.value} to 0 before closing jobs, so no accepted job can still be running when it returns.`,
  stops: [
    { when: { op: "wait", g: "test", node: "wg" }, say: `The counter still has accepted jobs to finish, so Close waits instead of returning early.` },
    { when: { op: "close", node: "jobs" }, say: "The counter reached 0. Only now does Close close jobs, and the workers' range loops end." },
  ],
  tests: { drain: tests.drain! },
  code: {
    file: "solution",
    text: `${SOLUTION_SUBMIT_TEST}
…
${SOLUTION_CLOSE_TEST}
…
${SOLUTION_WORKER}`,
  },
  expect: { outcome: "ok", tests: { drain: "pass" } },
} as const;

// The late path after Close has fully returned. No send reaches jobs.
const reject = {
  nodes: {
    test: goroutine({
      label: "test",
      pos: [0, 0],
      main: true,
      program: function* ({ vars }) {
        yield go("worker[*]");
        for (let i = 0; i < PRECLOSE; i++) {
          yield add("wg", 1, { at: "p.wg.Add(1)" });
          yield send("jobs", i, { at: "p.jobs <- job" });
          vars.accepted = (vars.accepted ?? 0) + 1;
          yield inc("accepted", 1, { at: "return true" });
        }
        yield set("closed", "closed", { at: "p.closed = true" });
        yield wait("wg", { at: "p.wg.Wait()" });
        yield close("jobs", { at: "close(p.jobs)" });
        vars.rejected = POSTCLOSE;
        yield inc("rejected", POSTCLOSE);
      },
    }),
    jobs: channel({ label: "jobs", pos: [1, 0], cap: 0 }),
    worker: goroutine({
      label: "worker",
      pos: [2, 0],
      count: WORKERS,
      base: 1,
      spawned: true,
      program: function* ({ vars }) {
        yield* range(
          "jobs",
          function* () {
            vars.ran = (vars.ran ?? 0) + 1;
            yield inc("ran", 1, { at: "job()" });
            yield done("wg", { at: "p.wg.Done()" });
          },
          { at: "range p.jobs" },
        );
      },
    }),
    wg: waitgroup({ label: "wg", pos: [1, 1] }),
    accepted: fact({ label: "accepted", pos: [0, 1], value: 0 }),
    ran: fact({ label: "ran", pos: [3, 0], value: 0 }),
    rejected: fact({ label: "rejected", pos: [3, 1], value: 0 }),
    closed: fact({ label: "closed", pos: [2, 1], value: "open", states: ["open", "closed"] }),
  },
  insight: `After Close returns, accepted and ran both equal ${PRECLOSE}. The ${POSTCLOSE} late calls see p.closed == true and return accepted=false without sending on jobs.`,
  stops: [
    { when: { op: "set", node: "closed" }, say: "The write lock makes closed visible before the drain begins." },
    { when: { op: "close", node: "jobs" }, say: "Close has drained every accepted job. It is now safe to close jobs." },
    { when: { op: "inc", node: "rejected" }, say: `All ${POSTCLOSE} late calls are rejected; ran remains ${PRECLOSE}.` },
  ],
  tests: { late: tests.late! },
  code: {
    file: "solution",
    text: `${SOLUTION_SUBMIT_TEST}
…
${SOLUTION_CLOSE_TEST}
…
${SOLUTION_WORKER}`,
  },
  expect: { outcome: "ok", tests: { late: "pass" } },
} as const;

export default defineViz({
  schema: 3,
  exercise: "37-safe-pool-shutdown",
  diagrams: { today: "fnv1a:01097e30", goal: "fnv1a:01097e30" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary:
        "Close closes jobs immediately; a late Submit reaches the closed channel and the test recovers the panic but still fails.",
      model: today,
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Every accepted job runs before Close returns, and the ${POSTCLOSE} Submit calls after it return accepted=false without running.`,
      model: goal,
    },
    {
      id: "admit",
      chip: "Admit",
      tier: "inside",
      summary: "Submit holds the read lock across its send, so Close's write lock cannot close jobs underneath it.",
      model: admit,
    },
    {
      id: "drain",
      chip: "Drain",
      tier: "inside",
      summary: `Close waits for all ${K.jobs.value} accepted jobs to call Done before it closes jobs and lets the workers return.`,
      model: drain,
    },
    {
      id: "reject",
      chip: "Reject",
      tier: "inside",
      summary: `After the drain, ${POSTCLOSE} late Submit calls see closed and return false without touching jobs.`,
      model: reject,
    },
  ],
});
