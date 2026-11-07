// 18 is about memory, not speed. The scaffold produces every item into a
// slice before it consumes any, so production runs 19 items ahead of the
// slow consumer. A channel with a small buffer makes the producer wait
// whenever the buffer is full: that wait is backpressure.

import { append, channel, close, defineViz, fact, go, goroutine, range, send, set, slice, work } from "../engine/ops.ts";
import type { Model, Params, RunSummary, TestDef } from "../engine/model.ts";

const K = {
  items: { value: 20, file: "check_test.go", text: "const itemCount = 20" },
  maxGap: { value: 5, file: "check_test.go", text: "const maxAllowedGap = 5" },
  consumeMs: { value: 50, file: "mockslowconsumer.go", text: "const ConsumeLatency = 50 * time.Millisecond" },
  cap: { value: 2, file: "README.md", text: "(e.g. size 2)" },
} as const;

const N = K.items.value;

// The test's own bookkeeping: gapAtProduce[i] = i - consumedSoFar.
function* produce(vars: Record<string, number>, i: number) {
  const gap = i - (vars.consumed ?? 0);
  vars.maxGap = Math.max(vars.maxGap ?? 0, gap);
  yield set("gap", gap, { at: "produce(i)" });
}

const tests: Record<string, TestDef> = {
  all: { name: "TestRunPipelineProcessesAllItems", short: "all items", judge: (run: RunSummary) => run.vars.consumed === N },
  bp: {
    name: "TestRunPipelineAppliesBackpressure",
    short: `gap ≤ ${K.maxGap.value}`,
    judge: (run: RunSummary) => (run.vars.maxGap ?? 0) <= K.maxGap.value,
  },
};

const gapNode = fact({ label: "gap", pos: [1, 1], value: 0, limit: K.maxGap.value });

function goal(P: Params): Model {
  const cap = Number(P.cap);
  return {
    nodes: {
      producer: goroutine({
        label: "producer",
        pos: [0, 0],
        spawned: true,
        program: function* ({ vars }) {
          for (let i = 0; i < N; i++) {
            yield* produce(vars, i);
            yield send("ch", i);
          }
          yield close("ch");
        },
      }),
      ch: channel({ label: "ch", pos: [1, 0], cap }),
      caller: goroutine({
        label: "caller",
        pos: [2, 0],
        main: true,
        program: function* ({ vars }) {
          yield go("producer");
          yield* range("ch", function* (r) {
            yield work(K.consumeMs.value, `consume(${r.v})`);
            vars.consumed = (vars.consumed ?? 0) + 1;
          });
        },
      }),
      gap: gapNode,
    },
    insight:
      cap >= N
        ? `With room for all ${N} items, the producer never waits, and the gap climbs to ${N - 1} just as it does today. Only a small buffer pushes back.`
        : `When ch is full and the caller is still in consume, the next send waits. The producer can never get more than ${cap + 1} items ahead, so the gap stays at ${cap + 1}.`,
    stops:
      cap > 0 && cap < N
        ? [{ when: { op: "block", g: "producer" }, say: `Both slots of ch are full, so the producer waits on ch <- while the caller consumes.` }]
        : [],
    tests,
    clock: { unit: "ms" },
    expect: { outcome: "ok", t: N * K.consumeMs.value, tests: { all: "pass", bp: cap + 1 <= K.maxGap.value ? "pass" : "fail" } },
  };
}

export default defineViz({
  schema: 3,
  exercise: "18-bounded-pipeline-backpressure",
  // The README draws Today and Goal in two fences, so each tier pins its own.
  diagrams: { today: "fnv1a:a6cf25d7", goal: "fnv1a:9ad63bf8" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `The caller produces all ${N} items into a slice before it consumes one, so the gap reaches ${N - 1}.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 0],
            main: true,
            program: function* ({ vars }) {
              for (let i = 0; i < N; i++) {
                yield* produce(vars, i);
                yield append("items", i);
              }
              for (let i = 0; i < N; i++) {
                yield work(K.consumeMs.value, `consume(${i})`, { at: "consume(item)" });
                vars.consumed = (vars.consumed ?? 0) + 1;
              }
            },
          }),
          items: slice({ label: "items", pos: [1, 0], size: N }),
          gap: gapNode,
        },
        insight: `All ${N} items land in memory before consume runs once, so production gets ${N - 1} items ahead. Nothing makes the producer wait for the slow consumer.`,
        tests,
        clock: { unit: "ms" },
        code: {
          file: "main.go",
          text: `
@caller func RunPipeline[T any](itemCount int, produce func(i int) T, consume func(item T)) {
@caller 	items := make([]T, 0, itemCount)
@caller 	for i := 0; i < itemCount; i++ {
@caller 		items = append(items, produce(i))
@caller 	}
@caller
@caller 	for _, item := range items {
@caller 		consume(item)
@caller 	}
@caller }`,
        },
        expect: { outcome: "ok", t: N * K.consumeMs.value, tests: { all: "pass", bp: "fail" } },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `A producer goroutine sends into ch with ${K.cap.value} slots; a full ch makes it wait, so the gap stays small.`,
      knobs: [{ key: "cap", label: "cap(ch)", options: [0, K.cap.value, N], value: K.cap.value }],
      model: goal,
    },
  ],
});
