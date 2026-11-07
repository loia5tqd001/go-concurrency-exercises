// The template for a new visualisation. `npm run viz -- new <exercise-id>`
// writes specs/<exercise-id>.ts from it, fills `exercise`, and writes both
// README diagram pins. Then write the scenes from the README and the
// committed code, and run `npm run check-visuals -- <id>`.
//
// A spec is a small Go program. Each goroutine node has a program: a
// generator that yields one operation per Go statement. The scheduler runs
// the programs under Go's rules and decides every order and time, so the
// graph cannot show what Go would not do. This file never names a colour, a
// glyph, or a pixel. The file name must start with a digit; the registry
// glob skips this template for that reason.
//
// The new-visualisation skill (.claude/skills/new-visualisation) is the
// whole contract. Read its REFERENCE.md before you write a scene.

import { channel, close, defineViz, goroutine, range, send, work } from "../engine/ops.ts";

// Every number names its source: `text` occurs in `file` (a committed file of
// the exercise) and contains `value`. viz-check proves it.
const K = {
  items: { value: 3, file: "check_test.go", text: "TODO: the line that holds 3" },
} as const;

export default defineViz({
  schema: 3,
  exercise: "<exercise-id>",
  diagrams: { today: "fnv1a:00000000", goal: "fnv1a:00000000" },
  constants: K,
  scenes: [
    {
      id: "today",
      chip: "Today",
      tier: "today",
      summary: "TODO: one sentence that says what the scaffold does.",
      model: {
        nodes: {
          // Data flows left to right: pos is [column, row].
          producer: goroutine({
            label: "producer",
            pos: [0, 0],
            program: function* () {
              for (let i = 0; i < K.items.value; i++) {
                yield work(20, "produce");
                yield send("ch", i);
              }
              yield close("ch");
            },
          }),
          ch: channel({ label: "ch", pos: [1, 0], cap: 0 }),
          caller: goroutine({
            label: "caller",
            pos: [2, 0],
            main: true,
            program: function* () {
              yield* range("ch", function* () {
                yield work(30, "consume");
              });
            },
          }),
        },
        insight: "TODO: one or two sentences: what to watch, and why it matters.",
        expect: { outcome: "ok" },
      },
    },
  ],
});
