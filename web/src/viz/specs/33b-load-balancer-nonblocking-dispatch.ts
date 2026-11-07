// 33b is about one blocking statement disabling the only goroutine that can
// drain done. TestBalancerSurvivesMoreRequestsThanWorkers submits
// 12 requests to three Workers with unbuffered inboxes. Today wedges while
// dispatching request 4. Goal queues the excess inside Balance and keeps
// servicing work and done. The inside scenes expose the nil-channel gate and
// the heap updates on both dispatch and completion.
//
// The schema has no collection of per-request buffered result channels, so
// they collapse to one shared buffered result channel. Each submitter receives
// a result and then owns its wg.Done. The named test returns while Balance and
// its Workers remain resident, so the model finishes with that real leak.

import {
  add,
  channel,
  defineViz,
  done,
  fact,
  fail,
  go,
  goroutine,
  onRecv,
  onSend,
  pass,
  put,
  recv,
  select,
  send,
  set,
  slice,
  start,
  timer,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { NodeDef, SelectCase, TestDef, Value } from "../engine/model.ts";

const K = {
  workers: { value: 3, file: "check_test.go", text: "const numWorkers = 3" },
  rounds: { value: 4, file: "check_test.go", text: "const numRequests = numWorkers * 4" },
  workMs: { value: 5, file: "check_test.go", text: "time.Sleep(5 * time.Millisecond)" },
  sendTimeoutS: { value: 2, file: "check_test.go", text: "case <-time.After(2 * time.Second):" },
} as const;

const W = K.workers.value;
const N = W * K.rounds.value;

const tests: Record<string, TestDef> = {
  queues: {
    name: "TestBalancerSurvivesMoreRequestsThanWorkers",
    short: "flat workers",
  },
};

const inbox = (i: number) => `inbox${i + 1}`;
const workerValue = (i: number) => `w${i + 1}`;

function workerIndex(value: unknown): number {
  const match = /^w([1-9])$/.exec(String(value));
  return match === null ? -1 : Number(match[1]) - 1;
}

// container/heap's stable tie-breaking keeps the existing order when pending
// counts are equal. Only the changed Worker can move after Fix.
function fixHeap(order: number[], pending: readonly number[], changed: number): number[] {
  const next = [...order];
  let i = next.indexOf(changed);
  if (i < 0) return next;

  if (i > 0 && pending[next[i]!]! < pending[next[Math.floor((i - 1) / 2)]!]!) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (pending[next[parent]!]! <= pending[next[i]!]!) break;
      [next[parent], next[i]] = [next[i]!, next[parent]!];
      i = parent;
    }
    return next;
  }

  for (;;) {
    let child = 2 * i + 1;
    if (child >= next.length) break;
    if (child + 1 < next.length && pending[next[child + 1]!]! < pending[next[child]!]!) child++;
    if (pending[next[i]!]! <= pending[next[child]!]!) break;
    [next[i], next[child]] = [next[child]!, next[i]!];
    i = child;
  }
  return next;
}

function workerNodes(): Record<string, NodeDef> {
  const nodes: Record<string, NodeDef> = {
    worker: goroutine({
      label: "worker",
      pos: [4, 0.5],
      count: W,
      base: 1,
      spawned: true,
      tone: 1,
      program: function* ({ i }) {
        let req = yield recv(inbox(i));
        for (;;) {
          yield work(K.workMs.value, "fn()");
          const result = Number(/^r([1-9][0-9]*)$/.exec(String(req.v))?.[1] ?? "1");
          yield send("result", result);
          yield send("done", workerValue(i));
          req = yield recv(inbox(i));
        }
      },
    }),
  };
  for (let i = 0; i < W; i++) {
    nodes[inbox(i)] = channel({ label: `inbox-${i + 1}`, pos: [3, i], cap: 0 });
  }
  return nodes;
}

function submitterNodes(): NodeDef {
  return goroutine({
    label: "submitter",
    pos: [0, 1],
    count: N,
    spawned: true,
    program: function* ({ i }) {
      yield send("work", `r${i + 1}`);
      yield recv("result");
      yield done("wg");
    },
  });
}

function tester(withTimeout: boolean): NodeDef {
  return goroutine({
    label: "test",
    pos: [0, 0],
    main: true,
    program: function* () {
      yield add("wg", N);
      yield put("pool", 0, "w1");
      yield put("pool", 1, "w2");
      yield put("pool", 2, "w3");
      yield go("worker[*]");
      yield go("balance");
      yield go("submitter[*]");

      if (withTimeout) {
        // The test's send timeout fires when dispatch wedges.
        yield start("timeout");
        yield recv("timeout");
        yield fail("queues");
        return;
      }

      yield wait("wg");
      yield pass("queues");
      // Returning is the test's honest end: Balance and Workers remain.
    },
  });
}

function scaffoldBalance(): NodeDef {
  return goroutine({
    label: "Balance",
    pos: [2, 0],
    spawned: true,
    program: function* () {
      const pending = Array<number>(W).fill(0);
      for (;;) {
        const got = yield select([onRecv("work"), onRecv("done")], { at: "select {" });
        if (got.i === 0) {
          let target = 0;
          for (let i = 1; i < W; i++) if (pending[i]! < pending[target]!) target = i;
          // This send is deliberately outside the select. It is the bug.
          yield send(inbox(target), got.tok, { at: "w.requests <- req" });
          pending[target]++;
        } else {
          const index = workerIndex(got.v);
          if (index >= 0) pending[index]--;
        }
      }
    },
  });
}

function fixedBalance(showInternals: boolean): NodeDef {
  return goroutine({
    label: "Balance",
    pos: [2, 0],
    spawned: true,
    program: function* () {
      const backlog: Value[] = [];
      const pending = Array<number>(W).fill(0);
      let order = Array.from({ length: W }, (_, i) => i);
      let dispatchState: string | undefined;

      if (showInternals) {
        yield set("dispatch", "nil", { at: "var dispatch chan<- Request" });
        dispatchState = "nil";
      }

      for (;;) {
        const target = order[0]!;
        const cases: SelectCase[] = [onRecv("work"), onRecv("done")];
        if (backlog.length > 0) cases.push(onSend(inbox(target), backlog[0]!));

        if (showInternals) {
          const nextState = backlog.length > 0 ? "ready" : "nil";
          if (nextState !== dispatchState) {
            yield set(
              "dispatch",
              nextState,
              { at: nextState === "nil" ? "var dispatch chan<- Request" : "dispatch, head = w.requests, backlog[0]" },
            );
            dispatchState = nextState;
          }
        }

        const got = yield select(cases, { at: "select {" });
        if (got.i === 0) {
          backlog.push(got.v);
          yield set("queue", backlog.length, { at: "backlog = append(backlog, req)" });
        } else if (got.i === 2) {
          backlog.shift();
          pending[target]++;
          order = fixHeap(order, pending, target);
          yield set("queue", backlog.length, { at: "backlog = backlog[1:]" });
          if (showInternals) {
            yield set("dispatch", backlog.length > 0 ? "ready" : "nil", {
              at: "dispatch, head = w.requests, backlog[0]",
            });
          }
          for (let i = 0; i < order.length; i++) {
            yield put("pool", i, workerValue(order[i]!), { at: "heap.Fix(&b.pool, w.index)" });
          }
        } else {
          const index = workerIndex(got.v);
          if (index >= 0) {
            pending[index]--;
            order = fixHeap(order, pending, index);
            for (let i = 0; i < order.length; i++) {
              yield put("pool", i, workerValue(order[i]!), { at: "heap.Fix(&b.pool, w.index)" });
            }
          }
        }
      }
    },
  });
}

const scaffoldCode = `
@worker func (w *Worker) work(done chan *Worker) {
@worker 	for req := range w.requests {
@worker 		req.c <- req.fn()
@worker 		done <- w
@worker 	}
@worker }
…
@balance func (b *Balancer) Balance(work <-chan Request) {
@balance 	for {
@balance 		select {
@balance 		case req := <-work:
@balance 			w := heap.Pop(&b.pool).(*Worker)
@balance 			w.requests <- req
@balance 			w.pending++
@balance 			heap.Push(&b.pool, w)
@balance
@balance 		case w := <-b.done:
@balance 			w.pending--
@balance 			heap.Fix(&b.pool, w.index)
@balance 		}
@balance 	}
@balance }`;

const solutionCode = `
@balance func (b *Balancer) Balance(work <-chan Request) {
@balance 	var backlog []Request
@balance
@balance 	for {
@balance 		var dispatch chan<- Request
@balance 		var head Request
@balance 		var w *Worker
@balance 		if len(backlog) > 0 {
@balance 			w = b.pool[0] // peek the least-loaded Worker; don't Pop yet
@balance 			dispatch, head = w.requests, backlog[0]
@balance 		}
@balance
@balance 		select {
@balance 		case req := <-work:
@balance 			backlog = append(backlog, req)
@balance
@balance 		case dispatch <- head:
@balance 			backlog = backlog[1:]
@balance 			w.pending++
@balance 			heap.Fix(&b.pool, w.index)
@balance
@balance 		case w := <-b.done:
@balance 			w.pending--
@balance 			heap.Fix(&b.pool, w.index)
@balance 		}
@balance 	}
@balance }`;

function scaffoldNodes(): Record<string, NodeDef> {
  return {
    test: tester(true),
    submitter: submitterNodes(),
    work: channel({ label: "work", pos: [1, 0], cap: 0 }),
    balance: scaffoldBalance(),
    ...workerNodes(),
    result: channel({ label: "result", pos: [4, 2], cap: 1 }),
    done: channel({ label: "done", pos: [3, 3], cap: 0 }),
    timeout: timer({ label: "timeout", pos: [1, 1], after: K.sendTimeoutS.value * 1000 }),
    wg: waitgroup({ label: "wg", pos: [1, 2] }),
    pool: slice({ label: "pool", pos: [2, 2], size: W }),
  };
}

function fixedNodes(showInternals: boolean): Record<string, NodeDef> {
  const nodes: Record<string, NodeDef> = {
    test: tester(false),
    submitter: submitterNodes(),
    work: channel({ label: "work", pos: [1, 0], cap: 0 }),
    balance: fixedBalance(showInternals),
    queue: fact({ label: "queue", pos: [2, 1], value: 0 }),
    pool: slice({ label: "pool", pos: [2, 2], size: W }),
    ...workerNodes(),
    result: channel({ label: "result", pos: [4, 2], cap: 1 }),
    done: channel({ label: "done", pos: [3, 3], cap: 0 }),
    wg: waitgroup({ label: "wg", pos: [1, 2] }),
  };
  if (showInternals) {
    nodes.dispatch = fact({ label: "dispatch", pos: [2, 3], value: "nil", states: ["nil", "ready"] });
  }
  return nodes;
}

const todayInsight =
  "At t=0 the first three sends reach fresh Workers. The fourth send targets a busy Worker and blocks outside the select. All three Workers finish at 5 ms and block on done, which Balance can no longer receive.";
const goalInsight =
  "Every request first enters Balance's queue. The same select keeps receiving new work and done reports, so a busy Worker cannot freeze the pool. After every submitter receives a result and the test returns, Balance and Workers remain resident: the final leak is fixture lifetime, not a failed fix.";

export default defineViz({
  schema: 3,
  exercise: "33b-load-balancer-nonblocking-dispatch",
  diagrams: { today: "fnv1a:c342398a", goal: "fnv1a:c342398a" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary:
        "Three unbuffered Worker inboxes accept one request each. Balance then blocks trying to send a fourth, so it cannot drain done.",
      model: {
        nodes: scaffoldNodes(),
        insight: todayInsight,
        stops: [
          {
            when: { op: "block", g: "balance" },
            say: "The fourth dispatch waits on a busy Worker's unbuffered inbox. Balance is now stuck outside its select.",
          },
          {
            when: { op: "block", g: "worker[1]", node: "done" },
            say: "A Worker finishes at 5 ms, sends its result, then blocks reporting done because Balance is still stuck.",
          },
          {
            when: { op: "fire", node: "timeout" },
            say: "At 2 s request 4 still has not been dispatched. The test fails; the Workers and Balance remain blocked.",
          },
        ],
        tests,
        clock: { unit: "ms" },
        code: { file: "main.go", text: scaffoldCode },
        expect: { outcome: "leak", t: K.sendTimeoutS.value * 1000, tests: { queues: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary:
        "Balance keeps requests it cannot hand off in its own queue. The select still receives work and done, and the Workers keep running.",
      model: {
        nodes: fixedNodes(false),
        insight: goalInsight,
        stops: [
          {
            when: { op: "set", node: "queue", nth: 2 },
            say: "The queue is doing its job: requests wait inside Balance while both Workers are already running.",
          },
          {
            when: { op: "block", g: "balance" },
            say: "No inbox can receive yet, so this select waits. It still has work and done among its cases.",
          },
          {
            when: { op: "recv", g: "balance", node: "done", nth: 1 },
            say: "A Worker reports done. Balance updates its load and can offer the first queued request to the freed Worker.",
          },
        ],
        tests,
        clock: { unit: "ms" },
        expect: { outcome: "leak", t: (N / W) * K.workMs.value, tests: { queues: "pass" } },
      },
    },
    {
      id: "queue",
      chip: "Queue",
      tier: "inside",
      summary:
        "The fix queues each request first. dispatch is nil with an empty queue, and it points at the least-loaded inbox only when there is a head.",
      model: {
        nodes: fixedNodes(true),
        insight:
          "With an empty backlog, dispatch stays nil and that select case is disabled. Once backlog is non-empty, Balance peeks pool[0] and enables the send. A done report can still wake the select and free a Worker first. The end is a leak only because the resident Balance and Workers outlive the test.",
        stops: [
          {
            when: { op: "set", node: "queue", nth: 2 },
            say: "A request waits in backlog. The next iteration points dispatch at the least-loaded Worker's inbox.",
          },
          {
            when: { op: "block", g: "balance" },
            say: "The inbox is not ready yet, but dispatch is only one select case. work and done remain live.",
          },
          {
            when: { op: "recv", g: "balance", node: "done", nth: 1 },
            say: "done arrives before the queued send. Balance decrements pending, fixes the heap, then retries dispatch.",
          },
        ],
        tests,
        clock: { unit: "ms" },
        code: { file: "solution", text: solutionCode },
        expect: { outcome: "leak", t: (N / W) * K.workMs.value, tests: { queues: "pass" } },
      },
    },
    {
      id: "heap",
      chip: "Heap",
      tier: "inside",
      summary:
        "pending rises when dispatch succeeds and falls when done arrives. pool is re-ordered after each change, so the next request goes to the least-loaded Worker.",
      model: {
        nodes: fixedNodes(true),
        insight:
          "A successful dispatch increments the chosen Worker's pending count and calls heap.Fix. A done report decrements it and calls the same primitive, so pool[0] tracks the least-loaded Worker. The final leak is the resident pool outliving the completed test, not a blocked request.",
        stops: [
          {
            when: { op: "put", node: "pool", nth: 4 },
            say: "Dispatch increments pending, then Fix moves the changed Worker deeper so pool[0] remains the least loaded.",
          },
          {
            when: { op: "recv", g: "balance", node: "done", nth: 1 },
            say: "done lowers pending. Fix restores the min-heap order without a Pop/Push round trip.",
          },
        ],
        tests,
        clock: { unit: "ms" },
        code: { file: "solution", text: solutionCode },
        expect: { outcome: "leak", t: (N / W) * K.workMs.value, tests: { queues: "pass" } },
      },
    },
  ],
});
