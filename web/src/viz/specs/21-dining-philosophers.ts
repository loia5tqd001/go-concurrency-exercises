// 21 is a lock-order problem: five philosophers, five forks, each fork a
// sync.Mutex. The scaffold has every philosopher lock its left fork, pause
// 1 ms, then lock its right fork. The pause lets all five take their left
// fork before any reaches for a right one, so each waits on a fork its
// neighbour holds and the wait closes a ring around the table. The inside
// scene locks the lower-indexed fork first, so the philosopher between F4
// and F0 reaches for F0 first and the ring cannot close.
//
// The scenes model main(), whose Dine(5, 3) never returns. The tests run the
// same Dine on a goroutine and give up after a timeout; this run shows why.
// There is no Goal scene: any picture of a working table names a strategy,
// and the README names none.

import { add, defineViz, done, go, goroutine, lock, mutex, sleep, unlock, wait, waitgroup } from "../engine/ops.ts";
import type { Model, NodeDef, Pos, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  philosophers: { value: 5, file: "main.go", text: "total := Dine(5, 3)" },
  meals: { value: 3, file: "main.go", text: "total := Dine(5, 3)" },
  reach: { value: "time.Millisecond", file: "main.go", text: "time.Sleep(time.Millisecond)" },
  eatUs: { value: 10, file: "main.go", text: "time.Sleep(10 * time.Microsecond)" },
} as const;

// The clock counts milliseconds: the reach is time.Millisecond, the meal
// 10 microseconds.
const REACH_MS = 1;
const EAT_MS = K.eatUs.value / 1000;

const N = K.philosophers.value;
const MEALS = K.meals.value;

// The table as a flattened ring, so a phone keeps two wide lanes. Going
// round: F0, P0, F1, P1, F2, P2, F3, P3, F4, P4, back to F0. Philosopher i
// sits between its left fork F[i] and its right fork F[(i+1) % 5]. main and
// the WaitGroup sit inside the ring.
const SEAT: Record<string, Pos> = {
  f0: [0, 0.62],
  p0: [0.5, 0],
  f1: [1.5, 0],
  p1: [2.5, 0],
  f2: [3.5, 0],
  p2: [4, 0.62],
  f3: [3.5, 1.24],
  p3: [2.5, 1.24],
  f4: [1.5, 1.24],
  p4: [0.5, 1.24],
  main: [1.6, 0.62],
  wg: [0.75, 0.62],
};

const fork = (i: number): string => `f${i % N}`;

// TestDineCompletesWithoutDeadlock runs Dine on its own goroutine and fails
// when Dine has not returned by its timeout. Whether Dine returns is a
// property of any run of this shape, so main()'s run is judged on it.
const tests: Record<string, TestDef> = {
  completes: { name: "TestDineCompletesWithoutDeadlock", short: "Dine returns", judge: (run) => run.outcome === "ok" },
};

type Order = (i: number) => [first: string, second: string];
// The scaffold: left fork first, then right.
const leftThenRight: Order = (i) => [fork(i), fork(i + 1)];
// The fix: the lower-indexed fork first.
const lowerFirst: Order = (i) => {
  const a = i;
  const b = (i + 1) % N;
  return a < b ? [fork(a), fork(b)] : [fork(b), fork(a)];
};

function table(order: Order, reach: boolean, at: { lock1: string; lock2: string; unlock1: string; unlock2: string }): Record<string, NodeDef> {
  const nodes: Record<string, NodeDef> = {};
  for (let i = 0; i < N; i++) {
    nodes[`f${i}`] = mutex({ label: `F${i}`, pos: SEAT[`f${i}`]! });
    const [first, second] = order(i);
    nodes[`p${i}`] = goroutine({
      label: `P${i}`,
      pos: SEAT[`p${i}`]!,
      spawned: true,
      program: function* () {
        for (let meal = 0; meal < MEALS; meal++) {
          yield lock(first, { at: at.lock1 });
          // The scaffold's pause while reaching for the second fork.
          if (reach) yield sleep(REACH_MS);
          yield lock(second, { at: at.lock2 });
          // eat; the meal counter is an atomic add, drawn as nothing.
          yield sleep(EAT_MS, { at: "time.Sleep(10 * time.Microsecond)" });
          yield unlock(second, { at: at.unlock2 });
          yield unlock(first, { at: at.unlock1 });
        }
        yield done("wg", { at: "defer wg.Done()" });
      },
    });
  }
  return nodes;
}

// main() calls Dine(5, 3): seat everyone, then wait for all of them. The
// solution doc shows no Dine body for the ordered fix, so that scene's main
// points at no line.
function caller(withLines: boolean): NodeDef {
  const at = (text: string) => (withLines ? { at: text } : {});
  return goroutine({
    label: "main",
    pos: SEAT.main!,
    main: true,
    program: function* () {
      for (let i = 0; i < N; i++) {
        yield add("wg", 1, at("wg.Add(1)"));
        yield go(`p${i}`, at("go p.Dine(&wg, &mealsEaten)"));
      }
      yield wait("wg", at("wg.Wait()"));
    },
  });
}

const today: Model = {
  nodes: {
    ...table(leftThenRight, true, {
      lock1: "p.leftFork.mu.Lock()",
      lock2: "p.rightFork.mu.Lock()",
      unlock1: "p.leftFork.mu.Unlock()",
      unlock2: "p.rightFork.mu.Unlock()",
    }),
    main: caller(true),
    wg: waitgroup({ label: "wg", pos: SEAT.wg! }),
  },
  insight:
    "Every philosopher locks its left fork, then pauses 1 ms. The pause lets all five take a left fork before any reaches right, so each waits on the fork its neighbour holds. The waits close a ring, and Dine never returns.",
  stops: [
    {
      when: { op: "lock", g: "p4", nth: 1 },
      say: "Each philosopher takes its left fork at once: P0 holds F0, P1 holds F1, and so on round the table.",
    },
    {
      // The fifth wait after the pause, whoever reaches last, closes the ring.
      when: { op: "block", t: REACH_MS, nth: N },
      say: "After the 1 ms pause all five reach right. Each right fork is a neighbour's left fork, so the last wait closes the ring.",
    },
  ],
  code: {
    file: "main.go",
    text: `
@p0,p1,p2,p3,p4 	defer wg.Done()
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 	for i := 0; i < p.mealsToEat; i++ {
@p0,p1,p2,p3,p4 		p.leftFork.mu.Lock()
…
@p0,p1,p2,p3,p4 		time.Sleep(time.Millisecond)
@p0,p1,p2,p3,p4 		p.rightFork.mu.Lock()
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 		// eat
@p0,p1,p2,p3,p4 		time.Sleep(10 * time.Microsecond)
@p0,p1,p2,p3,p4 		atomic.AddInt32(mealsEaten, 1)
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 		p.rightFork.mu.Unlock()
@p0,p1,p2,p3,p4 		p.leftFork.mu.Unlock()
@p0,p1,p2,p3,p4 	}
…
@main 		wg.Add(1)
@main 		go p.Dine(&wg, &mealsEaten)
@main 	}
@main 	wg.Wait()`,
  },
  tests,
  clock: { unit: "ms" },
  expect: { outcome: "deadlock", t: REACH_MS, tests: { completes: "fail" } },
};

const ordered: Model = {
  nodes: {
    ...table(lowerFirst, false, {
      lock1: "first.mu.Lock()",
      lock2: "second.mu.Lock()",
      unlock1: "first.mu.Unlock()",
      unlock2: "second.mu.Unlock()",
    }),
    main: caller(false),
    wg: waitgroup({ label: "wg", pos: SEAT.wg! }),
  },
  insight:
    "Every philosopher locks the lower-indexed fork first. P4 sits between F4 and F0, so it reaches for F0 first, the same fork P0 wants first. One of them waits holding nothing, so the ring can never close.",
  stops: [
    {
      when: { op: "block", g: "p4", nth: 1 },
      say: "P4's lower fork is F0, which P0 holds. P4 waits holding nothing, so no ring can close through it.",
    },
  ],
  code: {
    file: "solution",
    text: `
@p0,p1,p2,p3,p4 	defer wg.Done()
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 	first, second := p.leftFork, p.rightFork
@p0,p1,p2,p3,p4 	if second.index < first.index {
@p0,p1,p2,p3,p4 		first, second = second, first
@p0,p1,p2,p3,p4 	}
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 	for i := 0; i < p.mealsToEat; i++ {
@p0,p1,p2,p3,p4 		first.mu.Lock()
@p0,p1,p2,p3,p4 		second.mu.Lock()
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 		// eat
@p0,p1,p2,p3,p4 		time.Sleep(10 * time.Microsecond)
@p0,p1,p2,p3,p4 		atomic.AddInt32(mealsEaten, 1)
@p0,p1,p2,p3,p4
@p0,p1,p2,p3,p4 		second.mu.Unlock()
@p0,p1,p2,p3,p4 		first.mu.Unlock()
@p0,p1,p2,p3,p4 	}`,
  },
  // No clock: the lesson is the lock order, and 10 µs meals would only add
  // a fractional end time.
  tests,
  expect: { outcome: "ok", tests: { completes: "pass" } },
};

export default defineViz({
  schema: 3,
  exercise: "21-dining-philosophers",
  // The README's one plain fence draws the today state. There is no goal
  // scene, so both pins hold that fence's hash.
  diagrams: { today: "fnv1a:15103625", goal: "fnv1a:15103625" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: "Every philosopher takes its left fork, pauses, then waits forever for the right fork its neighbour holds, so Dine never returns.",
      model: today,
    },
    {
      id: "order",
      chip: "Order",
      tier: "inside",
      summary: "Each philosopher locks its lower-indexed fork first, so P4 waits for F0 instead of holding F4, and every meal gets eaten.",
      model: ordered,
    },
  ],
});

