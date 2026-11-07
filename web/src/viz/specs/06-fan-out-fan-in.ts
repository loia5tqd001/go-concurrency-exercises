// 06 is a throughput problem. Every ProcessImage call is independent, but
// the scaffold makes one call after another, so ten calls cost ten
// latencies. Fanned out, the calls overlap and cost one latency; the
// WaitGroup is the fan-in that lets the caller return only when all are in.

import {
  add,
  append,
  defineViz,
  done,
  go,
  goroutine,
  put,
  slice,
  wait,
  waitgroup,
  work,
} from "../engine/ops.ts";
import type { RunSummary, TestDef } from "../engine/model.ts";

// Every number names its source in the committed exercise.
const K = {
  images: { value: 10, file: "check_test.go", text: "const sequentialTime = 10 * ProcessingLatency" },
  latency: { value: 150, file: "mockimageprocessor.go", text: "const ProcessingLatency = 150 * time.Millisecond" },
  budget: { value: 500, file: "check_test.go", text: "const budget = 500 * time.Millisecond" },
} as const;

const N = K.images.value;
const thumb = (i: number): string => `t${i + 1}`;

// Every URL comes back exactly once.
const allIn = (run: RunSummary): boolean => run.world.slice.thumbnails?.every((cell) => cell !== null) === true;

const tests: Record<string, TestDef> = {
  correctness: { name: "TestGenerateThumbnailsCorrectness", short: "correctness", judge: allIn },
  concurrency: {
    name: "TestGenerateThumbnailsConcurrency",
    short: `under ${K.budget.value} ms`,
    judge: (run) => run.t < K.budget.value,
  },
  race: { name: "TestGenerateThumbnailsConcurrentCorrectness", short: "race-safe", judge: allIn },
};

const clock = { unit: "ms", budget: { at: K.budget.value, label: "budget" } } as const;

export default defineViz({
  schema: 3,
  exercise: "06-fan-out-fan-in",
  // One README fence draws both states, so both Problem tiers pin it.
  diagrams: { today: "fnv1a:0bfd898b", goal: "fnv1a:0bfd898b" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: `One goroutine calls ProcessImage ${N} times in a row, so the run takes ${N * K.latency.value} ms.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 0],
            main: true,
            program: function* () {
              for (let i = 0; i < N; i++) {
                yield work(K.latency.value, "ProcessImage");
                yield append("thumbnails", thumb(i));
              }
            },
          }),
          thumbnails: slice({ label: "thumbnails", pos: [1, 0], size: N }),
        },
        insight: `One goroutine calls ProcessImage ten times in a row. Each call waits for the one before, so the clock reaches ${N * K.latency.value} ms, three times the ${K.budget.value} ms budget.`,
        stops: [
          {
            when: { op: "append", nth: 1 },
            say: `The first thumbnail is in at ${K.latency.value} ms. Only now does the second call start.`,
          },
        ],
        tests,
        clock,
        code: {
          file: "main.go",
          text: `
@caller func GenerateThumbnails(urls []string) []Thumbnail {
@caller 	thumbnails := make([]Thumbnail, 0, len(urls))
@caller
@caller 	for _, url := range urls {
@caller 		thumbnails = append(thumbnails, ProcessImage(url))
@caller 	}
@caller
@caller 	return thumbnails
@caller }`,
        },
        expect: {
          outcome: "ok",
          t: N * K.latency.value,
          tests: { correctness: "pass", concurrency: "fail", race: "pass" },
        },
      },
    },
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      summary: `Ten goroutines run ProcessImage at once; the WaitGroup lets the caller return after ${K.latency.value} ms.`,
      model: {
        nodes: {
          caller: goroutine({
            label: "caller",
            pos: [0, 1],
            main: true,
            program: function* () {
              // Add comes before go: Add after go races with Done.
              yield add("wg", N);
              yield go("worker[*]");
              yield wait("wg");
            },
          }),
          wg: waitgroup({ label: "WaitGroup", pos: [1, 0] }),
          worker: goroutine({
            label: "worker",
            pos: [1, 1],
            count: N,
            base: 1,
            spawned: true,
            program: function* ({ i }) {
              yield work(K.latency.value, "ProcessImage");
              yield put("thumbnails", i, thumb(i));
              yield done("wg");
            },
          }),
          thumbnails: slice({ label: "thumbnails", pos: [2, 1], size: N }),
        },
        insight: `The caller starts one goroutine per URL, so all ten ProcessImage calls overlap. The WaitGroup counts them down and lets the caller return at ${K.latency.value} ms.`,
        stops: [
          {
            when: { op: "work", g: "worker", nth: N },
            say: "Ten calls run at once. The caller waits until the WaitGroup counts down to 0.",
          },
        ],
        tests,
        clock,
        expect: {
          outcome: "ok",
          t: K.latency.value,
          tests: { correctness: "pass", concurrency: "pass", race: "pass" },
        },
      },
    },
  ],
});
