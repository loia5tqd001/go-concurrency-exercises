// Planted faults: each must fail a named check in viz-check.ts. If a check
// stops firing, its test here fails first.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SceneDef, VizSpec } from "../src/viz/engine/model.ts";
import { channel, goroutine, recv, send, work } from "../src/viz/engine/ops.ts";
import { checkCode, checkPins, checkSpec, checkSpoilers, holdsValue, solutionIdentifiers, type Sources } from "./viz-check.ts";

const README = "# Demo\n\n```\nproducer ──▶ ch ──▶ consumer\n```\n\nThe producer sends values to the consumer.\n";
const SCAFFOLD = "package main\n\nfunc Run() {\n\tfor i := 0; i < 3; i++ {\n\t\tprocess(i)\n\t}\n}\n";
const TESTS = "package main\n\nfunc TestRun(t *testing.T) {}\n";
const SOLUTION = "func Run() {\n\tresults := make(chan int)\n\tvar wg sync.WaitGroup\n\tgo func() { results <- 1 }()\n\t<-results\n}\n";

const files: Record<string, string> = {
  "main.go": SCAFFOLD,
  "check_test.go": TESTS,
  "README.md": README,
  solution: SOLUTION,
};
const read = (_id: string, file: string): string | undefined => files[file];
const sources: Sources = { readme: README, go: `${SCAFFOLD}\n${TESTS}`, solution: SOLUTION };

function scene(over: Partial<SceneDef> = {}, insight = "The producer sends one value; the consumer receives it."): SceneDef {
  return {
    id: "goal",
    chip: "Goal",
    tier: "goal",
    summary: "One value goes from the producer to the consumer.",
    model: {
      nodes: {
        producer: goroutine({ label: "producer", pos: [0, 0], program: function* () { yield send("ch", 1); } }),
        ch: channel({ label: "ch", pos: [1, 0], cap: 0 }),
        consumer: goroutine({ label: "consumer", pos: [2, 0], main: true, program: function* () { yield recv("ch"); } }),
      },
      insight,
      expect: { outcome: "ok" },
    },
    ...over,
  };
}

function spec(scenes: SceneDef[]): VizSpec {
  return { schema: 3, exercise: "99-demo", diagrams: { today: "fnv1a:00000000", goal: "fnv1a:00000000" }, scenes };
}

function problems(s: VizSpec): string[] {
  const out: string[] = [];
  checkSpec("99-demo", s, (m) => out.push(m), sources, read);
  return out;
}

test("a clean spec passes", () => {
  assert.deepEqual(problems(spec([scene()])), []);
});

test("a goal text that names a solution-only identifier fails", () => {
  const out = problems(spec([scene({}, "The producer sends on results, and wg counts it.")]));
  assert.ok(out.some((m) => m.includes('"results" appears only in the solution')), out.join("\n"));
  assert.ok(out.some((m) => m.includes('"wg" appears only in the solution')), out.join("\n"));
});

test("spoilerOk allows a word, with a reason", () => {
  const s = spec([scene({}, "The producer sends on results.")]);
  s.spoilerOk = { results: "the README says results" };
  const out: string[] = [];
  const sc = s.scenes[0]!;
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  checkSpoilers("99-demo", s, sc, model, new Set(), sources, (m) => out.push(m));
  assert.deepEqual(out, []);
});

test("a wrong expected outcome fails, naming the seeds", () => {
  const bad = scene();
  const model = typeof bad.model === "function" ? bad.model({}) : bad.model;
  bad.model = { ...model, expect: { outcome: "leak" } };
  const out = problems(spec([bad]));
  assert.ok(out.some((m) => /expected "leak", but seeds 1,2/.test(m)), out.join("\n"));
});

test("a goal scene may not show code", () => {
  const sc = scene();
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  const out: string[] = [];
  checkCode("99-demo", sc, { ...model, code: { file: "main.go", text: "func Run() {" } }, (m) => out.push(m), read);
  assert.ok(out.some((m) => m.includes("a goal scene shows no code")));
});

test("a today excerpt line that is not verbatim fails", () => {
  const sc = scene({ tier: "today", id: "today", chip: "Today" });
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  const out: string[] = [];
  checkCode("99-demo", sc, { ...model, code: { file: "main.go", text: "@consumer func Run() {\n@consumer \tfor i := range 3 {" } }, (m) => out.push(m), read);
  assert.ok(out.some((m) => m.includes('"for i := range 3 {" is not a line of main.go')), out.join("\n"));
});

test("a constant whose text is not in its file fails", () => {
  const s = spec([scene()]);
  s.constants = { n: { value: 5, file: "main.go", text: "i < 5" } };
  assert.ok(problems(s).some((m) => m.includes('constant n: "i < 5" is not in main.go')));
});

test("a label the learner has not seen fails in a Problem scene", () => {
  const sc = scene();
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  sc.model = { ...model, nodes: { ...model.nodes, consumer: { ...model.nodes.consumer!, label: "sink" } } };
  assert.ok(problems(spec([sc])).some((m) => m.includes('labelled "sink"')));
});

test("a work label over budget and a long token fail", () => {
  const sc = scene();
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  sc.model = {
    ...model,
    nodes: {
      ...model.nodes,
      producer: goroutine({
        label: "producer",
        pos: [0, 0],
        program: function* () {
          yield work(5, "a very long work label");
          yield send("ch", "pulse");
        },
      }),
    },
  };
  const out = problems(spec([sc]));
  assert.ok(out.some((m) => m.includes('work label "a very long work label"')));
  assert.ok(out.some((m) => m.includes('token value "pulse"')));
});

test("a pin that matches no README fence fails", () => {
  const out: string[] = [];
  checkPins("99-demo", spec([scene()]), README, (m) => out.push(m));
  assert.ok(out.some((m) => m.includes("matches no plain fence")));
});

test("two nodes at one grid position fail", () => {
  const sc = scene();
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  sc.model = { ...model, nodes: { ...model.nodes, ch: channel({ label: "ch", pos: [0, 0], cap: 0 }) } };
  assert.ok(problems(spec([sc])).some((m) => m.includes("share pos [0, 0]")));
});

test("a number must stand alone in its constant's text", () => {
  assert.equal(holdsValue("const workers = 100", 10), false);
  assert.equal(holdsValue("const workers = 10", 10), true);
  assert.equal(holdsValue("10 * ProcessingLatency", 10), true);
  assert.equal(holdsValue("x = 1.5", 1), false);
  assert.equal(holdsValue("time.Millisecond", "time.Millisecond"), true);
});

test("a solution-only name is not hidden inside a longer README word", () => {
  const out: string[] = [];
  const s = spec([scene({}, "The producer sends res to the consumer.")]);
  const sc = s.scenes[0]!;
  const model = typeof sc.model === "function" ? sc.model({}) : sc.model;
  const solution = "func Run() {\n\tres := make(chan int)\n\t<-res\n}\n";
  checkSpoilers("99-demo", s, sc, model, new Set(), { readme: README + "\nthe result", go: SCAFFOLD, solution }, (m) => out.push(m));
  assert.ok(out.some((m) => m.includes('"res" appears only in the solution')), out.join("\n"));
});

test("both names of `a, b :=` count as declared by the solution", () => {
  const ids = solutionIdentifiers("alpha, beta := f()\n");
  assert.ok(ids.has("alpha") && ids.has("beta"));
});
