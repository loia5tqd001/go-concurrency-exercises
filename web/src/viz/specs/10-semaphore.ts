// 10 is about a limit that has two sides. The scaffold starts one goroutine
// per request and all of them call the API in the same instant, so the API
// refuses what is past its own limit. A buffered channel as a semaphore holds
// the number of calls in flight at a chosen cap. Too high a cap breaks the
// first test (high-water mark above 2); too low a cap breaks the second
// (the batch takes longer than its budget).
//
// Two tests, two runs. TestFetchAllRespectsSemaphoreLimit (12 requests, an API
// that tolerates 3) is the run of Today and Goal. TestFetchAllStillConcurrent
// (10 requests, an API with ample room) is the run of the inside scene. A scene
// judges only the test whose run it is.
//
// Not drawn: the FlakyAPI mutex (its lock only makes `current++` and the
// `tooMany` check one step, which `apiCall` does in one JavaScript step), the
// `current` counter, and the `results` slice. The two facts are what the test
// reads: the high-water mark, and the results that start with "ERROR:".

import {
  add,
  channel,
  defineViz,
  done,
  fact,
  go,
  goroutine,
  inc,
  recv,
  send,
  wait,
  waitgroup,
  work,
  SIGNAL,
} from "../engine/ops.ts";
import type { Model, Op, Params, Self, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  apiMax: { value: 3, file: "check_test.go", text: "const apiMaxConcurrent = 3" },
  hwmWant: { value: 2, file: "check_test.go", text: "const wantMaxHighWaterMark = 2" },
  reqs: { value: 12, file: "check_test.go", text: "reqs := testReqs(12)" },
  latency: { value: 100, file: "mockapi.go", text: "const CallLatency = 100 * time.Millisecond" },
  speedReqs: { value: 10, file: "check_test.go", text: "reqs := testReqs(10)" },
  budget: { value: 600, file: "check_test.go", text: "const budget = 600 * time.Millisecond" },
  maxInFlight: { value: 2, file: "../solutions/10-semaphore.md", text: "const maxInFlight = 2" },
} as const;

const N = K.reqs.value;
const rounds = (n: number, slots: number): number => Math.ceil(n / slots);

const tests: Record<string, TestDef> = {
  respects: {
    name: "TestFetchAllRespectsSemaphoreLimit",
    short: "hwm ≤ 2, no ERR",
    judge: (run) => (run.vars.hwm ?? 0) <= K.hwmWant.value && (run.vars.errors ?? 0) === 0,
  },
};

const speedTests: Record<string, TestDef> = {
  concurrent: {
    name: "TestFetchAllStillConcurrent",
    short: `under ${K.budget.value} ms`,
    judge: (run) => run.t < K.budget.value,
  },
};

// FlakyAPI.Call as the mock writes it: current++, raise the high-water mark,
// refuse when current passes the limit, else sleep CallLatency. `current` lives
// in `vars`; the high-water mark node moves through `inc`, so it adds up
// whatever the order of the goroutines. Returns false when the call came back
// with an error.
function* apiCall(vars: Self["vars"], limit: number): Generator<Op, boolean, unknown> {
  vars.current = (vars.current ?? 0) + 1;
  const raised = Math.max(0, vars.current - (vars.hwm ?? 0));
  vars.hwm = (vars.hwm ?? 0) + raised;
  const tooMany = vars.current > limit;
  if (raised > 0) yield inc("highWaterMark", raised, { at: "api.Call(r)" });
  if (tooMany) {
    vars.current -= 1;
    return false;
  }
  yield work(K.latency.value, "api.Call", { at: "api.Call(r)" });
  vars.current -= 1;
  return true;
}

// `results[i] = "ERROR: " + err.Error()` when the call failed.
function* record(vars: Self["vars"], ok: boolean): Generator<Op, void, unknown> {
  if (ok) return;
  vars.errors = (vars.errors ?? 0) + 1;
  yield inc("errors", 1, { at: 'results[i] = "ERROR: "' });
}

// What every scene shares: the caller that starts one goroutine per request
// and waits, the WaitGroup, and the two facts the test reads.
function caller(n: number) {
  return goroutine({
    label: "FetchAll",
    pos: [0, 1],
    main: true,
    program: function* () {
      for (let i = 0; i < n; i++) {
        yield add("wg", 1, { at: "wg.Add(1)" });
        yield go(`request[${i}]`, { at: "go func(i int, r string)" });
      }
      yield wait("wg", { at: "wg.Wait()" });
    },
  });
}

const wg = waitgroup({ label: "wg", pos: [1, 0] });
const errors = fact({ label: "ERROR", pos: [2, 0.5], value: 0 });
const highWaterMark = fact({ label: "hwm", pos: [2, 1.5], value: 0, limit: K.hwmWant.value });

function goal(P: Params): Model {
  const slots = Number(P.slots);
  const t = rounds(N, slots) * K.latency.value;
  const fits = slots <= K.hwmWant.value;
  const insight =
    slots === 1
      ? `One slot keeps the API safe, but the calls run one after another and take ${t} ms. The limit is there, the concurrency is gone.`
      : fits
        ? `Each request takes a slot before it calls the API. Only ${slots} slots exist, so the rest wait here and the API never sees more than ${slots} calls. The ${N} calls run in ${rounds(N, slots)} rounds.`
        : `${slots} slots match the API's own limit, so nothing is refused, but the high-water mark reaches ${slots}. The test allows ${K.hwmWant.value}.`;
  return {
    nodes: {
      caller: caller(N),
      wg,
      request: goroutine({
        label: "request",
        pos: [1, 1],
        count: N,
        spawned: true,
        program: function* ({ vars }) {
          yield send("semaphore", SIGNAL);
          const ok: boolean = yield* apiCall(vars, K.apiMax.value);
          yield* record(vars, ok);
          yield recv("semaphore");
          yield done("wg");
        },
      }),
      semaphore: channel({ label: "semaphore", pos: [1, 2], cap: slots }),
      errors,
      highWaterMark,
    },
    insight,
    stops:
      slots < N
        ? [{ when: { op: "block", g: "request" }, say: `All ${slots} slots are taken, so this request waits here, not at the API.` }]
        : [],
    tests,
    clock: { unit: "ms" },
    expect: { outcome: "ok", t, tests: { respects: fits ? "pass" : "fail" } },
  };
}

// The solution under TestFetchAllStillConcurrent: 10 requests, an API with
// room for 100, so nothing is refused and only the gate sets the speed.
function speed(P: Params): Model {
  const slots = Number(P.cap);
  const n = K.speedReqs.value;
  const t = rounds(n, slots) * K.latency.value;
  const fast = t < K.budget.value;
  return {
    nodes: {
      caller: caller(n),
      wg,
      request: goroutine({
        label: "request",
        pos: [1, 1],
        count: n,
        spawned: true,
        program: function* () {
          yield send("sem", SIGNAL, { at: "sem <- struct{}{}" });
          yield work(K.latency.value, "api.Call", { at: "api.Call(r)" });
          yield recv("sem", { at: "defer func() { <-sem }()" });
          yield done("wg", { at: "defer wg.Done()" });
        },
      }),
      sem: channel({ label: "sem", pos: [1, 2], cap: slots }),
    },
    insight: fast
      ? `The ${n} calls pass through ${slots} slot${slots === 1 ? "" : "s"} in ${rounds(n, slots)} rounds of ${K.latency.value} ms, so the batch ends at ${t} ms, inside the ${K.budget.value} ms budget.`
      : `With one slot the ${n} calls run one after another and end at ${t} ms. That passes the API's limit and fails the speed test: a semaphore caps concurrency, it must not remove it.`,
    stops: [{ when: { op: "block", g: "request" }, say: `The slots are full, so the other requests wait on sem <-.` }],
    tests: speedTests,
    clock: { unit: "ms", budget: { at: K.budget.value, label: "budget" } },
    code: {
      file: "solution",
      text: `
@caller func FetchAll(api *FlakyAPI, reqs []string) []string {
@caller 	results := make([]string, len(reqs))
@caller 	var wg sync.WaitGroup
@caller
@caller 	sem := make(chan struct{}, maxInFlight)
@caller
@caller 	for i, r := range reqs {
@caller 		wg.Add(1)
@caller 		go func(i int, r string) {
@request 			defer wg.Done()
@request
@request 			sem <- struct{}{}
@request 			defer func() { <-sem }()
@request
@request 			res, err := api.Call(r)
@request 			if err != nil {
@request 				results[i] = "ERROR: " + err.Error()
@request 				return
@request 			}
@request 			results[i] = res
@caller 		}(i, r)
@caller 	}
@caller
@caller 	wg.Wait()
@caller
@caller 	return results
@caller }`,
    },
    expect: { outcome: "ok", t, tests: { concurrent: fast ? "pass" : "fail" } },
  };
}

export default defineViz({
  schema: 3,
  exercise: "10-semaphore",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:aaf9743b", goal: "fnv1a:aaf9743b" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `FetchAll starts ${N} goroutines that call the API at once. It refuses everything past ${K.apiMax.value} calls with ERROR, and the high-water mark passes ${K.hwmWant.value}.`,
      model: {
        nodes: {
          caller: caller(N),
          wg,
          request: goroutine({
            label: "request",
            pos: [1, 1],
            count: N,
            spawned: true,
            program: function* ({ vars }) {
              const ok: boolean = yield* apiCall(vars, K.apiMax.value);
              yield* record(vars, ok);
              yield done("wg", { at: "defer wg.Done()" });
            },
          }),
          errors,
          highWaterMark,
        },
        insight: `All ${N} requests call the API in the same instant. It takes ${K.apiMax.value}, refuses the other ${N - K.apiMax.value} on the spot with ERROR, and its high-water mark climbs past the ${K.hwmWant.value} the test allows.`,
        stops: [
          {
            when: { op: "return", g: "request", nth: 1 },
            say: `The API already holds ${K.apiMax.value} calls, so this one is refused at once. Nothing queues.`,
          },
          {
            when: { op: "end" },
            say: `At ${K.latency.value} ms the ${K.apiMax.value} accepted calls end. ${N - K.apiMax.value} of ${N} results are ERR, and the test fails.`,
          },
        ],
        tests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@caller func FetchAll(api *FlakyAPI, reqs []string) []string {
@caller 	results := make([]string, len(reqs))
@caller 	var wg sync.WaitGroup
@caller
@caller 	for i, r := range reqs {
@caller 		wg.Add(1)
@caller 		go func(i int, r string) {
@request 			defer wg.Done()
@request
@request 			res, err := api.Call(r)
@request 			if err != nil {
@request 				results[i] = "ERROR: " + err.Error()
@request 				return
@request 			}
@request 			results[i] = res
@caller 		}(i, r)
@caller 	}
@caller
@caller 	wg.Wait()
@caller
@caller 	return results
@caller }`,
        },
        expect: { outcome: "ok", t: K.latency.value, tests: { respects: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Each request takes one of a few slots before it calls the API, so the API sees at most that many calls and refuses none.`,
      knobs: [{ key: "slots", label: "slots", options: [1, K.hwmWant.value, K.apiMax.value], value: K.hwmWant.value }],
      model: goal,
    },
    {
      id: "speed",
      chip: "Speed",
      tier: "inside",
      summary: `Under the speed test, ${K.speedReqs.value} calls pass through the slots; one slot ends at ${K.speedReqs.value * K.latency.value} ms, over the ${K.budget.value} ms budget.`,
      knobs: [{ key: "cap", label: "maxInFlight", options: [1, K.maxInFlight.value, K.apiMax.value], value: K.maxInFlight.value }],
      model: speed,
    },
  ],
});
