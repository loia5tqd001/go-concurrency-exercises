// 23 is about the span of a lock, not race freedom. The scaffold already has
// one mutex protecting one map correctly, but it holds that mutex while work
// runs. A slow key therefore blocks an unrelated fast key. Sharding gives the
// two keys different mutexes, while keys that hash to the same shard still use
// one lock and remain serialized.
//
// TestCacheDifferentKeysDontBlockEachOther is the Today/Goal run. Its two
// literals land in shard 1 and shard 2. The inside scenes use the same Do
// critical section for the 50-caller same-key test, then isolate the empty-key
// branch that keeps the first-byte hash from panicking.

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
  set,
  unlock,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { RunSummary, Self, TestDef } from "../engine/model.ts";

// All numbers come from the committed test or the worked solution.
const K = {
  slowWork: { value: 200, file: "check_test.go", text: "const slowWork = 200 * time.Millisecond" },
  budget: { value: 50, file: "check_test.go", text: "const budget = 50 * time.Millisecond" },
  sameKeyCallers: { value: 50, file: "check_test.go", text: "const goroutines = 50" },
  increment: { value: 1, file: "check_test.go", text: "return cur + 1" },
  emptyResult: { value: 7, file: "check_test.go", text: "return cur + 7" },
} as const;

const tests = {
  different: {
    name: "TestCacheDifferentKeysDontBlockEachOther",
    short: `keyB < ${K.budget.value} ms`,
    // elapsed := time.Since(start), then elapsed >= budget fails.
    judge: (run: RunSummary) => (run.vars.elapsed ?? Infinity) < K.budget.value,
  },
  same: {
    name: "TestCacheSameKeySerializesCorrectly",
    short: `${K.sameKeyCallers.value} same-key`,
    judge: (run: RunSummary) => run.vars.count === K.sameKeyCallers.value,
  },
  correctness: {
    name: "TestCacheCorrectness",
    short: "empty key",
    judge: (run: RunSummary) => run.vars.empty === K.emptyResult.value,
  },
} satisfies Record<string, TestDef>;

const differentTests = { different: tests.different };
const sameTests = { same: tests.same };

// TestCacheDifferentKeysDontBlockEachOther in the scaffold: both callers use
// Cache.mu, and the first caller holds it while its callback sleeps.
const todayPrograms = {
  test: function* ({ vars }: Self) {
    yield go("slow");
    yield recv("entered");
    yield lock("mu", { at: "c.mu.Lock()" });
    yield work(0, "work(keyB)", { at: "next := work(cur)" });
    yield unlock("mu", { at: "defer c.mu.Unlock()" });
    vars.elapsed = K.slowWork.value;
    yield set("elapsed", K.slowWork.value);
    yield recv("finished");
  },
  slow: function* () {
    yield lock("mu", { at: "c.mu.Lock()" });
    yield close("entered");
    yield work(K.slowWork.value, "work(keyA)", { at: "next := work(cur)" });
    yield unlock("mu", { at: "defer c.mu.Unlock()" });
    yield close("finished");
  },
};

// Under the worked sharded solution, keyA and keyB select different shard
// mutexes. work still runs under each lock, but each lock now has one lane.
const goalPrograms = {
  test: function* ({ vars }: Self) {
    yield go("slow");
    yield recv("entered");
    yield lock("shardB", { at: "s.mu.Lock()" });
    yield work(0, "work(keyB)", { at: "next := work(cur)" });
    yield unlock("shardB", { at: "defer s.mu.Unlock()" });
    vars.elapsed = 0;
    yield set("elapsed", 0);
    yield recv("finished");
  },
  slow: function* () {
    yield lock("shardA", { at: "s.mu.Lock()" });
    yield close("entered");
    yield work(K.slowWork.value, "work(keyA)", { at: "next := work(cur)" });
    yield unlock("shardA", { at: "defer s.mu.Unlock()" });
    yield close("finished");
  },
};

const SCAFFOLD_DO = `
type Cache struct {
\tmu   sync.Mutex
\tdata map[string]int
}
…
@slow,test func (c *Cache) Do(key string, work func(cur int) int) int {
@slow,test \tc.mu.Lock()
@slow,test \tdefer c.mu.Unlock()
@slow,test
@slow,test \tcur := c.data[key]
@slow,test \tnext := work(cur)
@slow,test \tc.data[key] = next
@slow,test \treturn next
@slow,test }`;

const SOLUTION_DO = `
@slow,test func (c *Cache) Do(key string, work func(cur int) int) int {
@slow,test \ts := c.shardFor(key)
@slow,test
@slow,test \ts.mu.Lock()
@slow,test \tdefer s.mu.Unlock()
@slow,test
@slow,test \tcur := s.data[key]
@slow,test \tnext := work(cur)
@slow,test \ts.data[key] = next
@slow,test \treturn next
@slow,test }`;

const SAME_KEY_DO = `
@worker func (c *Cache) Do(key string, work func(cur int) int) int {
@worker \ts := c.shardFor(key)
@worker
@worker \ts.mu.Lock()
@worker \tdefer s.mu.Unlock()
@worker
@worker \tcur := s.data[key]
@worker \tnext := work(cur)
@worker \ts.data[key] = next
@worker \treturn next
@worker }`;

const EMPTY_SHARD = `
@test func (c *Cache) shardFor(key string) *shard {
@test \tif len(key) == 0 {
@test \t\treturn c.shards[0]
@test \t}
@test \tidx := int(key[0]) % numShards
@test \treturn c.shards[idx]
@test }`;

export default defineViz({
  schema: 3,
  exercise: "23-sharded-cache",
  diagrams: { today: "fnv1a:83b72611", goal: "fnv1a:83b72611" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The unrelated keyB call waits for the same global mutex that keyA holds during ${K.slowWork.value} ms of work.`,
      model: {
        nodes: {
          test: goroutine({ label: "test", pos: [0, 1], main: true, program: todayPrograms.test }),
          slow: goroutine({ label: "slow", pos: [1, 1], spawned: true, program: todayPrograms.slow }),
          mu: mutex({ label: "mu", pos: [1, 0] }),
          entered: channel({ label: "entered", pos: [2, 0], cap: 0 }),
          finished: channel({ label: "done", pos: [2, 2], cap: 0 }),
          elapsed: fact({ label: "elapsed", pos: [2, 1], value: 0, limit: K.budget.value, unit: "ms" }),
        },
        routes: { "test>finished": "below" },
        insight: `keyA wakes the test only after it holds mu. keyB then asks for that same mutex and waits until keyA's ${K.slowWork.value} ms callback returns. Race-free, but unrelated work is serialized.`,
        stops: [
          {
            when: { op: "lock", g: "test", node: "mu" },
            say: `The test reaches keyB, but mu is still held by slow keyA work. The lock does not know the keys differ.`,
          },
          {
            when: { op: "set", node: "elapsed" },
            say: `keyB finally runs at ${K.slowWork.value} ms. That is over the ${K.budget.value} ms test budget.`,
          },
        ],
        tests: differentTests,
        clock: { unit: "ms", budget: { at: K.budget.value, label: "budget" } },
        code: { file: "main.go", text: SCAFFOLD_DO },
        expect: { outcome: "ok", t: K.slowWork.value, tests: { different: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `keyA and keyB select different shard locks, so keyB finishes immediately while keyA's slow callback continues.`,
      model: {
        nodes: {
          test: goroutine({ label: "test", pos: [0, 1], main: true, program: goalPrograms.test }),
          slow: goroutine({ label: "slow", pos: [1, 1], spawned: true, program: goalPrograms.slow }),
          shardA: mutex({ label: "shard[a]", pos: [1, 0] }),
          shardB: mutex({ label: "shard[b]", pos: [1, 2] }),
          entered: channel({ label: "entered", pos: [2, 0], cap: 0 }),
          finished: channel({ label: "done", pos: [2, 2], cap: 0 }),
          elapsed: fact({ label: "elapsed", pos: [2, 1], value: 0, limit: K.budget.value, unit: "ms" }),
        },
        routes: { "test>finished": "below" },
        insight: `Both calls still keep a lock across work, but the keys land in different shards. keyA holds shard[a]; keyB takes shard[b] at once, so its elapsed time stays under ${K.budget.value} ms.`,
        stops: [
          {
            when: { op: "work", g: "slow" },
            say: "keyA is still working while holding shard[a]. Its callback no longer occupies every other key's lock.",
          },
          {
            when: { op: "set", node: "elapsed" },
            say: "keyB completes immediately on shard[b], while keyA's slow work continues on shard[a].",
          },
        ],
        tests: differentTests,
        clock: { unit: "ms", budget: { at: K.budget.value, label: "budget" } },
        expect: { outcome: "ok", t: K.slowWork.value, tests: { different: "pass" } },
      },
    },
    {
      id: "lanes",
      chip: "Lanes",
      tier: "inside",
      summary: "The solution chooses a shard before locking, so the critical section is unchanged but each lock covers only one lane.",
      model: {
        nodes: {
          test: goroutine({ label: "test", pos: [0, 1], main: true, program: goalPrograms.test }),
          slow: goroutine({ label: "slow", pos: [1, 1], spawned: true, program: goalPrograms.slow }),
          shardA: mutex({ label: "shard[a]", pos: [1, 0] }),
          shardB: mutex({ label: "shard[b]", pos: [1, 2] }),
          entered: channel({ label: "entered", pos: [2, 0], cap: 0 }),
          finished: channel({ label: "done", pos: [2, 2], cap: 0 }),
          elapsed: fact({ label: "elapsed", pos: [2, 1], value: 0, limit: K.budget.value, unit: "ms" }),
        },
        routes: { "test>finished": "below" },
        insight: `Do still locks, reads, runs work, writes, and unlocks. The change is the receiver: s points at the selected shard, so each lane has its own mutex and map.`,
        stops: [
          {
            when: { op: "lock", g: "slow", node: "shardA" },
            say: "shardFor(keyA) returns shard[1]. The lock held across work is now only shard[1].mu.",
          },
          {
            when: { op: "lock", g: "test", node: "shardB" },
            say: "keyB selects shard[2], whose mutex is free, so it does not queue behind shard[1].",
          },
        ],
        tests: differentTests,
        clock: { unit: "ms", budget: { at: K.budget.value, label: "budget" } },
        code: { file: "solution", text: SOLUTION_DO },
        expect: { outcome: "ok", t: K.slowWork.value, tests: { different: "pass" } },
      },
    },
    {
      id: "same-key",
      chip: "Same key",
      tier: "inside",
      summary: `All ${K.sameKeyCallers.value} callers for shared-key queue on one shard mutex, so every read-modify-write sees the previous value.`,
      model: {
        nodes: {
          test: goroutine({
            label: "test",
            pos: [0, 1],
            main: true,
            program: function* () {
              yield add("wg", K.sameKeyCallers.value);
              yield go("worker[*]");
              yield wait("wg");
            },
          }),
          wg: waitgroup({ label: "wg", pos: [0, 0] }),
          worker: goroutine({
            label: "worker",
            pos: [1, 1],
            count: K.sameKeyCallers.value,
            spawned: true,
            program: function* ({ vars }) {
              yield lock("shardShared", { at: "s.mu.Lock()" });
              yield work(0, "work(shared)", { at: "next := work(cur)" });
              vars.count = (vars.count ?? 0) + K.increment.value;
              yield inc("sharedKey", K.increment.value, { at: "s.data[key] = next" });
              yield unlock("shardShared", { at: "defer s.mu.Unlock()" });
              yield done("wg");
            },
          }),
          shardShared: mutex({ label: "shared", pos: [1, 0] }),
          sharedKey: fact({
            label: "shared-key",
            pos: [1, 2],
            value: 0,
            limit: K.sameKeyCallers.value,
          }),
        },
        insight: `The fast callbacks do not need to overlap: they target the same key. One shard mutex makes the ${K.sameKeyCallers.value} increments a sequence, so no two callers can read the same old value.`,
        stops: [
          {
            when: { op: "block", g: "worker" },
            say: "Another worker already holds the shared-key shard. The rest wait instead of entering the same read-modify-write.",
          },
          {
            when: { op: "done", node: "wg", nth: K.sameKeyCallers.value },
            say: `wg reaches zero only after shared-key reaches ${K.sameKeyCallers.value}. No updates were dropped.`,
          },
        ],
        tests: sameTests,
        code: { file: "solution", text: SAME_KEY_DO },
        expect: { outcome: "ok", tests: { same: "pass" } },
      },
    },
    {
      id: "empty",
      chip: "Branch",
      tier: "inside",
      summary: "Contract branch, not a full test run: shardFor checks len(key) before key[0], then the empty key uses shard 0.",
      model: {
        nodes: {
          test: goroutine({
            label: "branch",
            pos: [0, 1],
            main: true,
            program: function* ({ vars }) {
              yield set("key", "");
              yield lock("shardZero");
              vars.empty = K.emptyResult.value;
              yield set("result", K.emptyResult.value);
              yield unlock("shardZero");
            },
          }),
          key: fact({ label: "key", pos: [1, 0], value: "" }),
          shardZero: mutex({ label: "shard[0]", pos: [1, 1] }),
          result: fact({ label: "result", pos: [2, 1], value: 0 }),
        },
        insight: `This scene isolates the empty-key assertion inside TestCacheCorrectness; it does not replay that whole test. The formula needs key[0], so the explicit branch returns shard[0] first.`,
        stops: [
          {
            when: { op: "lock", g: "test", node: "shardZero" },
            say: "len(key) is zero, so shardFor returns shards[0] without evaluating key[0].",
          },
          {
            when: { op: "set", node: "result" },
            say: `The empty-key callback returns ${K.emptyResult.value}, and the final observation sees that stored value.`,
          },
        ],
        code: { file: "solution", text: EMPTY_SHARD },
        expect: { outcome: "ok" },
      },
    },
  ],
});
