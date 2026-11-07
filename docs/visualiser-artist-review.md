# Visualiser review and target architecture

> **Superseded on 2026-11-07.** The visualiser was rebuilt as a scheduler and a graph view. The current design and its decisions are in `docs/visualiser-design.md`; the authoring contract is `.claude/skills/new-visualisation/`. This file is kept as history.

**Status:** Phases 1–3 are built and accepted (§7.7). Nothing is committed yet; the owner decides the commits.
**Date:** 2026-11-05.
**Reader:** the agent that implements the visualiser, and the owner.
**Input:** `docs/visualiser-artist-brief.md`, the engine under `web/src/viz/`, the three pilot specs, the checks, and screenshots of a temporary build at the 260 px pane floor.

**How the screenshots were made.** `vite build --outDir /tmp/viz-review/dist`, then `vite preview --outDir … --port 4317`, then headless Chrome over the DevTools Protocol at a 1300 px viewport with `gce:v1:pref:doc-frac = 0.2` in `localStorage`. This puts the doc pane at 260 px and does not touch `web/dist`. Repeat this method to check any change in this document.

---

## 1. Verdict

### 1.1 What works — keep it

| Piece | Why it is right | Artifact |
| --- | --- | --- |
| A spec is data, and a pure fold turns it into a frame | Play, Step, the transcript, and the tests all read one function. Nothing reads a clock. | `web/src/viz/fold.ts:52-75` |
| One lazy chunk per spec | Each spec costs 5.4–6.5 kB raw and 1.4–2.1 kB gzip. The main bundle does not grow. | `vite build` output |
| Captions, a transcript, and `aria-live` | Every frame has a text equivalent. | `web/src/viz/VizPlayer.tsx:121-138` |
| Reduced motion starts paused | The player knows the preference; it does not rely on CSS alone. | `web/src/viz/useReducedMotion.ts` |
| Fix scenes stay behind the existing reveal | There is one spoiler gate, not two. | `web/src/components/DocPane.tsx:61-65` |
| Anchors are checked against committed files | A scaffold edit can fail a spec. | `web/scripts/viz-check.ts:85-87` |
| No third tab | The tab row already overflows at 260 px. | `docs/visualisation-handoff.md` §1.1 |
| The 04 board replaced the one-bar timeline | 04 is about state, not time. That diagnosis is correct. | `web/src/viz/specs/04-graceful-sigint.ts:3-5` |

### 1.2 What does not work — five findings

**F1. Red means "blocked", so the fix scenes look broken.**
A parked goroutine is normal Go. In 18 the parked send *is* the fix. The CSS paints every blocked actor with `--fail` (`web/src/styles.css:1272-1275`, `:1345-1350`). At step 3 of the 18 fix scene, the producer chip reads "blocked: send" in red. At step 2 of the 04 fixed scene, "main parked: select" is red. The learner sees an alarm on the correct program. Tone is also chosen per spec (`web/src/viz/spec.ts:5`), so one scene can contradict itself: in 31 "deadline wins", the deadline rule is red (`31-serve-timeout-race.ts:136`) and the `ctx.Done` marker at the same instant is green (`:114`).

**F2. The spec describes pixels, not Go, so a wrong story passes.**
The events are renderer words: `span`, `marker`, `cell`, `counter`, and a free-text `phase`. The fold guesses "blocked" from the phase string (`fold.ts:124-127`). Three consequences:

- 04 says main is "waiting for a signal" (`04-graceful-sigint.ts:116`). The fold classifies it as *running*, but main is parked on `<-sigChan`.
- The 04 fixed scene starts the Stop goroutine at t = 0 (`04-graceful-sigint.ts:169-176`). The solution starts it only after the first signal (`solutions/04-graceful-sigint.md:82`, `:89`). Nothing objects.
- A channel is a board of cells with spec-chosen state words, so items have no identity. At 18 step 4 the consumer takes item 0 and the parked send completes, but both slots show "▣ queued" before and after (`18-bounded-pipeline-backpressure.ts:176-187`). The one moment the scene exists to show is invisible.

The fold also keeps fields that no view draws: `gates`, `notes`, and `Actor.role` everywhere, and `messages`, `axisLabel`, and `outT` in the board view. An author can write those events and see nothing.

**F3. There is no visual language yet, only two widgets.**
A goroutine is a lane row in 31 and a chip in 04 and 18. A channel is a text tag in lanes and a cell board in boards. Specs choose glyphs freely: "▣" means "signal" in 04 and "queued" in 18. The CSS uses nine font sizes from 8.5 px to 12.5 px (`styles.css:1265` is 8.5 px). At the 260 px floor:

| Measure | Value | Effect |
| --- | --- | --- |
| Figure height | 404–636 px | The figure is taller than the visible pane. |
| Transport row | 56 px (two rows) | The four text buttons wrap. On a 320 px phone the row is 26 px. |
| Truncated labels | "blocked: s…", "s…" (select), "a…" (append) | The state text the lesson needs is cut off. |
| Stage share | about 40 % of the figure | Controls, the scene `<select>`, and a five-line note dominate. |
| Motion | none | The CSS has no `transition`; the reduced-motion block disables nothing. Steps jump, and the eye cannot find what changed. |
| Accent text on `--bg-sunken` | 4.20 : 1 | Below WCAG AA for small text (`.viz-state.state-running`, `styles.css:1279`). |

The 18 scaffold scene has 41 steps on an "event order 0 … 50" axis. The player hides this with a speed hack (`VizPlayer.tsx:37`). The pile of 20 items in memory, the actual symptom, appears only as a counter.

**F4. The visual sits in the wrong place.**
The panel mounts after the whole README, below "Test your solution" (`DocPane.tsx:56-57`). The README already has an ASCII diagram that tells the same story higher up. About 35 of 43 READMEs label that diagram with "today" and "goal" (heuristic grep). The learner reads the diagram, starts coding, and never scrolls to a collapsed panel at the end.

**F5. The checks prove shape, not truth or sync.**

- Anchors are searched in one string that joins every exercise file *and* the solution doc (`viz-check.ts:53`, `:75-87`). A scaffold anchor passes if only the solution contains it.
- The README check proves a diagram *exists* (`viz-check.ts:89-96`). The diagram can change completely and the check stays green.
- The check reads `HEAD:<id>/README.md` (`viz-check.ts:90`). The local site renders the working-tree README (`web/tools/gen/main.go:127-136`). The check and the screen can disagree.
- Nothing validates state names, counter ids, rules, or captions. An unknown cell state renders its raw string with "·" (`GaugeView.tsx:34`).
- Expectations live in one hand-edited test file that imports every spec by name (`viz-fold.test.ts:8-10`). Each new spec edits shared code.
- Numbers in captions are not tied to provenance. 31 "handler wins" says "before the 2 s deadline" (`31-serve-timeout-race.ts:58`), but its axis ends at 600 ms and draws no 2 s rule.

### 1.3 The change with the highest leverage

**Make the spec speak Go, and let the fold run it.**

Replace the render events with about fifteen Go verbs (`go`, `send`, `recv`, `close`, `select`, `lock`, `wait`, …) over typed cast members (goroutine, channel, mutex, wait group, context, and a few plain facts). The fold executes channel semantics. It *derives* parked, handed off, woken, leaked, dropped, and panicked. The spec can no longer claim a state that Go would not produce.

This one change fixes most of F1–F3 and F5:

- The kit, not the spec, picks every color and glyph from the derived state (F1, F3).
- A send to a full channel parks the sender, so a wrong story fails in the fold (F2, F5).
- One renderer knows what a channel is, so every exercise draws it the same way (F3).
- Specs get shorter. The 18 fix scene drops from 97 lines (`18-bounded-pipeline-backpressure.ts:132-228`) to about 30.

The second change, the "diagram door" in §4, fixes F4 and the sync half of F5.

---

## 2. Target architecture

### 2.1 Shape

```
 <id>/README.md (working tree locally, HEAD in CI and deploy)
   plain-fence diagram ──fnv1a──▶ "fnv1a:8c41e0d2"
                                        │  equal?  ◀── tools/check lint rule `viz-diagram`
 web/src/viz/specs/<id>.ts              │
   diagram: "fnv1a:8c41e0d2" ───────────┘
   constants (value + file + text)  ──▶ viz-check: text is in file, text contains value
   cast (goroutines, channels, facts)
   scenes (tier, outcome, steps of Go verbs, expect)
        │
        ▼
 kit/run.ts  ── Go semantics fold ──▶  World[i] + changed[i] + errors
        │                                     │
        │                         viz-check: no errors, outcome, expect, budgets
        ▼
 kit/Stage.tsx ──▶ kinds/<kind>.tsx rows        VizPlayer.tsx (transport, keys, captions)
        ▲                                             ▲
        └──────────── VizDoor.tsx ────────────────────┘
          Problem tab: mounts on the README fence whose hash matches
          Solution tab: mounts at the top of the revealed write-up
```

### 2.2 File map

| Path | Role | Who edits it |
| --- | --- | --- |
| `web/src/viz/kit/model.ts` | Cast kinds, `World`, the `Op` union, `schema: 2` | Kit maintainer only |
| `web/src/viz/kit/run.ts` | The fold. Go semantics for goroutines, channels, `select`, mutex, wait group, context, clock. Computes `changed` and `errors`. | Kit maintainer only |
| `web/src/viz/kit/ops.ts` | Helpers that build ops: `go()`, `send()`, `recv()`, … `defineViz()` | Kit maintainer only |
| `web/src/viz/kit/kinds/<kind>.tsx` | One row kind: `init`, `apply` (fact ops), `Row`, `text`, `check` | Kit maintainer; a new kind needs no player edit |
| `web/src/viz/kit/kinds/index.ts` | `kind → module` map | Kit maintainer |
| `web/src/viz/kit/Stage.tsx` | Draws rows in cast order, the clock strip, and the change ring | Kit maintainer only |
| `web/src/viz/kit/glyphs.tsx` | The only glyph source (inline SVG) | Kit maintainer only |
| `web/src/viz/kit/diagramHash.ts` | FNV-1a over a normalized fence body; shared by the site and the checks | Kit maintainer only |
| `web/src/viz/VizPlayer.tsx` | Transport, scene chips, keyboard, caption, transcript | Kit maintainer only |
| `web/src/viz/VizDoor.tsx` | The mount: diagram ⇄ scenes in Problem; a block in Solution | Kit maintainer only |
| `web/src/viz/registry.ts` | `import.meta.glob("./specs/[0-9]*.ts")`: one lazy chunk per file, no hand-kept list | Nobody, after the switch |
| `web/src/viz/specs/<id>.ts` | **The only file an author writes** | Spec author |
| `web/src/viz/specs/_template.ts` | Annotated template (excluded by the glob) | Kit maintainer |
| `web/scripts/viz.ts` | `npm run viz -- new <id>`, `pin <id>`, `shots <id>` | Kit maintainer |
| `web/scripts/viz-check.ts` | Static and semantic checks (§2.5) | Kit maintainer |
| `web/scripts/viz-kit.test.ts` | Unit tests of the Go model itself | Kit maintainer |
| `tools/check/lint.go` | New rule `viz-diagram` (§2.6) | Kit maintainer |
| `.claude/skills/new-visualisation/SKILL.md`, `REFERENCE.md` | The authoring walkthrough and the verb and kind tables; plus the `.agents/skills` symlink | Kit maintainer |

Delete after the migration: `views/LaneView.tsx`, `views/GaugeView.tsx`, `fmt.ts`, the v1 types in `spec.ts`, and the per-spec tests in `viz-fold.test.ts`.

### 2.3 The authoring contract

**A visualisation is one file: `web/src/viz/specs/<id>.ts`.** The author does not touch the player, the kit, the CSS, the registry, or a test file.

#### The smallest correct spec

This is the 18 spec with one scene. It is the canonical example; §3.4 shows how it renders.

```ts
// web/src/viz/specs/18-bounded-pipeline-backpressure.ts
import { close, defineViz, drain, exit, go, pass, recv, send, set, work } from "../kit/ops.ts";

// Every number the scenes use comes from here. viz-check proves that `text`
// occurs in `file` and contains `value`, so a scaffold edit fails the spec.
const K = {
  items: { value: 20, file: "check_test.go", text: "itemCount = 20" },
  maxGap: { value: 5, file: "check_test.go", text: "maxAllowedGap = 5" },
  cap: { value: 2, file: "README.md", text: "size 2" },
} as const;

export default defineViz({
  schema: 2,
  exercise: "18-bounded-pipeline-backpressure",
  // Written by `npm run viz -- pin 18`. It names the README diagram this
  // spec animates; the Problem scenes mount on that fence.
  diagram: "fnv1a:8c41e0d2",
  constants: K,
  // Rows render top to bottom in this order: who runs, what they share,
  // then what the test sees.
  cast: {
    producer: { kind: "goroutine", label: "producer" },
    items: { kind: "cells", label: "[]T", size: K.items.value },
    ch: { kind: "channel", label: "ch", cap: K.cap.value, tier: "goal" },
    consumer: { kind: "goroutine", label: "consumer" },
    gap: { kind: "meter", label: "gap", limit: K.maxGap.value },
    tests: {
      kind: "tests",
      names: { all: "TestRunPipelineProcessesAllItems", bp: "TestRunPipelineAppliesBackpressure" },
      short: { all: "all items", bp: "backpressure" },
    },
  },
  scenes: [
    {
      id: "goal",
      chip: "Goal",
      tier: "goal",
      outcome: "pass",
      summary: "A channel with 2 slots makes the producer wait, so the gap never passes 3.",
      steps: [
        { say: "The producer starts. The consumer waits for the first item.",
          do: [go("producer"), go("consumer"), recv("consumer", "ch")] },
        { say: "Item 0 goes straight to the waiting consumer, which starts consume(0).",
          do: [send("producer", "ch", 0), work("consumer", "consume"), set("gap", 0)] },
        { say: "Items 1 and 2 fill both slots of ch.",
          do: [send("producer", "ch", 1), send("producer", "ch", 2), set("gap", 2)] },
        { say: "produce(3) finds both slots full, so the producer waits on ch.",
          do: [send("producer", "ch", 3), set("gap", 3)] },
        { say: "consume(0) ends. The consumer takes item 1, and the waiting send drops item 3 into the free slot.",
          do: [recv("consumer", "ch"), work("producer", "produce")] },
        { say: "This repeats for all 20 items. The gap never passes 3, so both tests pass.",
          do: [close("producer", "ch"), exit("producer"), drain("consumer", "ch"), exit("consumer"),
               pass("tests.all"), pass("tests.bp")] },
      ],
      expect: { producer: "exited", consumer: "exited", gap: 3, "tests.bp": "pass" },
    },
  ],
});
```

Note step 2. A first draft says "items 0 and 1 fill both slots". The fold disagrees: the consumer is already parked on `recv`, so Go hands item 0 directly to it and bypasses the buffer. The `expect` or the frame then contradicts the caption, and the author fixes the story. The kit teaches the author Go while it checks the spec.

#### The verbs

The fold derives everything in the right-hand column. The author never writes a state word for a runtime row.

| Op | Go meaning | What the fold derives |
| --- | --- | --- |
| `go(g)` | `go f()` | g runs. |
| `exit(g)` | The function returns. | g exits. A later op on g is an error. |
| `work(g, text)` | g computes or sleeps. | g runs; the row shows `text` (≤ 12 characters). |
| `send(g, ch, v)` | `ch <- v` | Hand-off to a parked receiver; else a free slot; else g parks holding v. |
| `recv(g, ch)` | `<-ch` | Takes the oldest slot and pulls a parked sender's value into the buffer; else takes from a parked sender (unbuffered); else gets the zero value if closed; else g parks. |
| `close(g, ch)` | `close(ch)` | Wakes every parked receiver; a parked or later sender panics. |
| `select(g, cases, { pick })` | `select` | One ready case: it runs. Two or more ready: `pick` is required, and the caption gets "(Go picks a ready case at random)". None ready: g parks on all; a later op on any case channel wakes g through that case. |
| `signal(ch, v)` | A runtime send that never blocks: `signal.Notify`, `time.After` | Hand-off; else a slot; else the value is dropped, and the row shows the drop. |
| `lock(g, mu)`, `unlock(g, mu, { to })` | `sync.Mutex` | One holder. Waiters are a *set*. `unlock` must name the next holder; the kit never implies FIFO. |
| `add(wg, n)`, `done(g, wg)`, `wait(g, wg)` | `sync.WaitGroup` | Counter; waiters wake at 0; below 0 is a panic. |
| step field `t` | Time passes. | Timers fire; a context whose deadline passed closes its `Done` channel and wakes its selects. |
| `cancel(ctx)` | `cancel()` | `Done` closes. |
| `panic(g, text)` | A panic. | The scene outcome must be `panic`. |
| `kill(text)` | `os.Exit`, or the default SIGINT action | Every goroutine exits; a `lamp` with `process: true` turns off. |
| `set(id, v)` | A fact takes a value. | A meter number, a lamp's `on` or `off` word, a machine state. Not cells. |
| `add(id, n)` | A number grows by n. | A meter value, or a wait group counter (`wg.Add(n)`). Nothing else. |
| `push(id, v)` | `s = append(s, v)` | Cells: v fills the next empty slot. Full cells are an error. |
| `put(id, i, v)` | `s[i] = v` | Cells: v fills slot i. |
| `pass(test)`, `fail(test)` | A test result. | The tests row. |
| `repeat(n, i => ops)` | A loop | n iterations in one step. Tokens stream in with a stagger. |
| `drain(g, ch)` | `for v := range ch` | `recv` until the channel is closed and empty. |

#### The cast kinds

| Kind | Fields | The row shows |
| --- | --- | --- |
| `goroutine` | `label`, optional `count` (a group, addressed as `workers[3]` or `workers[*]`) | Status glyph, name, op text, the held token, the time underline |
| `channel` | `label`, `cap` (0 = unbuffered) | Slots with tokens in receive order, a closed mark, the waiting count |
| `mutex` | `label` | The holder and a waiter count. Never a queue. |
| `waitgroup` | `label` | The counter and a waiter count |
| `context` | `label`, optional `deadline` | Live or closed, and how many goroutines listen |
| `cells` | `label`, `size` | Indexed slots: a slice, shards, a heap array. Over 5 cells, a dense strip of ticks. |
| `meter` | `label`, optional `unit`, `limit` | The value, a bar to the limit, red past the limit |
| `lamp` | `label`, `on`/`off` words, optional `process` | One boolean fact, such as "process alive" |
| `machine` | `label`, `states` | State pills with the current one filled (22 circuit breaker) |
| `tests` | `names` (full), `short` (≤ 14 characters) | Pending, pass, or fail per test |

**Tiers** decide where a scene and a row may appear:

| Tier | Meaning | Where it mounts | Vocabulary allowed |
| --- | --- | --- | --- |
| `today` | What the scaffold does | Problem tab, on the README diagram | README and scaffold words only |
| `goal` | What the README diagram promises, at the README's level of detail | Problem tab, on the README diagram, once the Phase 2 guard passes (§7, decision 1); the Solution tab until then | README and scaffold words only |
| `inside` | How the fix works, and the traps | Solution tab, after the reveal | Anything |

A cast member takes the earliest tier in which it may appear (default `today`). Problem scenes share one row list. A row that a scene does not use renders as a ghost ("not started"). So switching Today ⇄ Goal never moves a row, and the eye sees only what changes. `inside` rows never render in the Problem tab.

**Outcome.** Each scene declares one of `pass`, `fail`, `leak`, `deadlock`, or `panic`. The fold checks it against the final world:

| Outcome | Must be true at the end |
| --- | --- |
| `pass` | No goroutine is parked, and every test in the cast passed. |
| `fail` | At least one test failed. |
| `leak` | At least one goroutine is parked, and the caller has exited. It renders as "parked forever" in red. |
| `deadlock` | Every live goroutine is parked. The kit names the wait-for cycle. |
| `panic` | A `panic` op or a send on a closed channel happened. |

**Expect.** A partial world at the end of the scene, and optionally per step. One generic check runs every `expect`. Nobody edits a test file for a new spec.

#### Never

| Never | Why | What stops it |
| --- | --- | --- |
| Edit the player, the kit, a kind, or the CSS to make a spec work | The language must stay one language. | Review; the skill says to stop and report a missing primitive. |
| Choose a color, a glyph, or a size | Specs chose them before, and the language fragmented. | The types have no such field. |
| Write a number that is not a constant, a token, or a clock time | Numbers drift from the code. | viz-check (§2.5) |
| Put a solution-only word in a `today` or `goal` scene | It spoils the exercise. | viz-check spoiler rule |
| Claim an order Go does not promise | A scene is a model, not a trace. | `select` needs `pick` and adds the random-choice note; mutex waiters are a set. |
| Edit `main.go`, `check_test.go`, or a mock | The owner keeps solutions there. | The edit guard |
| Change a README diagram without re-pinning | The clone and the site drift. | `make lint` rule `viz-diagram` |

### 2.4 Renderer families become row kinds

Lanes and boards are not two families. They are two halves of one stage:

| The brief's primitive | Where it lives |
| --- | --- |
| Clock | A scene option: `clock: { unit: "ms", end: 600, marks: { deadline: 100, budget: 150 } }` |
| Span | The goroutine row's time underline, drawn from the fold's history |
| Block state | Derived by the fold: parked, and on what |
| Handoff | A token moving between rows |
| Slot | `channel` and `cells` rows |
| Waiter | A parked goroutine row plus the waiting count on the channel, mutex, or wait group row |
| State machine | The `machine` kind |
| Heap | The `cells` kind (array form). Draw a tree only if 24 is ever built. |

**The runtime model is closed.** Goroutines, channels, `select`, mutex, wait group, context, and the clock live in `run.ts`. A new runtime primitive (for example `sync.Cond`) is rare. It is a `run.ts` change with tests in `viz-kit.test.ts`.

**Fact kinds are open.** A new fact kind is one file:

```ts
// web/src/viz/kit/kinds/<kind>.tsx
export interface Kind<Def, State> {
  init(def: Def): State;
  apply?(state: State, op: FactOp): State | string; // a string is an error message
  Row(props: { id: string; def: Def; state: State; changed: boolean }): JSX.Element;
  text(def: Def, state: State): string;             // the row as one sentence, for screen readers
  check?(def: Def): string[];                       // static problems, as fix-it messages
}
```

Register it in `kinds/index.ts`. The player and the stage do not change.

`model.ts` derives the fact half of `CastDef` and of the world from that registry, and `run.ts` sends every fact op (`set`, `add` on a meter, `push`, `put`, `pass`, `fail`) to the kind's `apply`. Neither file contains a `switch` on a fact kind. The proof is a test: a throwaway fact kind, defined inside the test, works with one module and one registry entry, and needs no edit to `model.ts`, `run.ts`, the stage, or the player (§7, decision 6).

**Versioning.** Each spec carries `schema: 2` as a literal type. `run.ts` refuses another number with a message. A breaking change bumps the number and ships a codemod that rewrites every spec in the same commit. There are at most 43 specs, so the site never runs two schemas. Additive changes (a new verb, a new kind) do not bump the number.

### 2.5 Validation path

| Layer | Command | What it asserts | Example message |
| --- | --- | --- | --- |
| Types | `npx tsc --noEmit` | Known kinds, verbs, tiers, and fields; no color or glyph fields exist | `Type '"blocked"' is not assignable to …` |
| Static | `npm run check-visuals` | The spec file matches an exercise; `diagram` matches a fence in the README the site renders | `18: no README fence hashes to fnv1a:8c41e0d2. The diagram changed or is not saved. Re-read it, update the scenes if the story changed, then run: npm run viz -- pin 18` |
| | | Every constant's `text` occurs in its `file` and contains its `value` | `18: constant maxGap: "maxAllowedGap = 5" not found in 18-bounded-pipeline-backpressure/check_test.go` |
| | | Anchors are checked per file, not in one joined string | `31: anchor "return handler()" not found in main.go` |
| | | Vocabulary: every `today` or `goal` row label occurs in the README | `06: row label "collector" is not in the README. Problem rows use the README's own words.` |
| | | Spoilers: no `today` or `goal` text contains a solution-only identifier | `06/goal step 3: "wg.Wait" appears only in solutions/06-fan-out-fan-in.md:94. Rename it, or move this step to an inside scene.` |
| | | Budgets (§3.3) | `06/today step 2: caption is 141 characters; the limit is 120.` |
| | | Numbers in captions are constants, tokens, or clock times of that frame (units normalized) | `06/goal step 2: "3" is not a constant, a token, or the clock. Add it to constants with its source.` |
| | | Order: flow rows first, fact rows after, `tests` last | `04: meter "signals" comes before goroutine "stop". Facts go after the rows that run.` |
| Semantic | `npm run check-visuals` | The fold reports no errors | `31/leak step 3: handler sends on resCh after Serve exited, but resCh has no slot. The send parks forever. Set outcome: "leak", or give resCh cap 1.` |
| | | Every step changes at least one visible thing | `31/today step 2: nothing changed. Merge it with the next step, or move the clock.` |
| | | The outcome matches the final world | `06/goal: outcome is pass, but 9 goroutines are parked at the end: workers[1..9] send → fan-in. An unbuffered channel hands off one value per receive.` |
| | | Every `expect` holds | `18/goal end: gap is 2, expected 3.` |
| Model | `npm run test-visuals` | The Go semantics: hand-off to a parked receiver, buffered `recv` pulls a parked sender, `close` wakes receivers and panics senders, `select` needs `pick` when two cases are ready, `signal` drops when full, the wait group panics below 0 | Ordinary test failures |
| Lint | `make lint` | `viz-diagram`: each spec's `diagram` matches a fence in its README (§2.6) | Same text as the static check |
| Pixels | `npm run viz -- shots <id>` (phase 3) | At 216 px and 288 px, in light and dark: no horizontal overflow, no truncated text (`scrollWidth > clientWidth`), controls ≥ 32 px, figure ≤ 420 px tall at the floor (6 rows, a clock, and a 4-line caption add up to about 406 px) | `06/goal at 216 px: row "workers" overflows by 9 px.` |
| Human | Review | The caption-off test (below) | — |

**What "beautiful enough to merge" means.** The machine checks the budgets, the honesty rules, and the pixels. A human (or a reviewing agent with the screenshots) checks three things:

1. **Caption-off.** Hide the captions. Look at the last frame of each scene. Can you name the bug or the fix? If not, the stage does not carry the lesson.
2. **The ring.** In each step, does the change ring land on the thing the caption names, and on little else?
3. **One difference.** Do Today and Goal differ by exactly the lesson? Same rows, same order, different behavior.

### 2.6 The spec-to-README link

**Decision: pin, do not derive.**

| Option | Verdict | Reason |
| --- | --- | --- |
| Generate the ASCII diagram from the spec | No | The README diagrams carry hand-written judgment ("still running?", "(last resort)" in `04-graceful-sigint/README.md`). A generator would flatten them. GitHub readers deserve the hand-drawn version. |
| Generate the spec from the ASCII diagram | No | The diagram has no semantics to parse. |
| Pin the diagram by hash, check shared words, and mount on the pinned fence | **Yes** | One value detects drift *and* decides placement. |

**Mechanics.**

1. `diagramHash(body)` is FNV-1a 32-bit (offset `0x811c9dc5`, prime `0x01000193`) over the UTF-8 fence body after this normalization: split on `\n`, strip `\r` and trailing spaces and tabs from each line, drop leading and trailing empty lines, join with `\n`. Output: `fnv1a:` plus 8 lowercase hex digits. The TypeScript (`kit/diagramHash.ts`) and Go (`tools/check`, `hash/fnv`) versions share one fixture test with a known hash.
2. `web/src/markdown.ts` stamps every plain fence with `data-diagram="fnv1a:…"`.
3. `VizDoor` mounts the Problem scenes on the fence whose stamp equals `spec.diagram`.
4. `npm run viz -- pin <id>` writes the hash into the spec. If the README has more than one diagram fence, it lists them and asks for `--fence N`.
5. **Live docs.** The dev server regenerates on every README save. If the owner edits the pinned diagram, the stamp changes and the door loses its anchor:
   - In `npm run dev`, the scenes render after the README with a strip: "This scene was written for an older diagram. Re-check it, then run `npm run viz -- pin 06`."
   - In a production build, the Problem scenes do not render (fail closed). Solution scenes still render.
6. **Check what you render.** viz-check reads the README from the same place the generator does: the working tree. In CI the working tree is `HEAD`, so CI checks what deploys.
7. **`make lint` rule `viz-diagram`** (Go, in `tools/check/lint.go`). It runs in the stop guard and the commit gate, so an agent that edits only a README is caught without Node. In `precommit` mode it compares against the staged README (`git show :<id>/README.md`), so a pin cannot pass against an unstaged diagram.
8. **Shared words.** Every `today` or `goal` row label must occur in the README. A rename in the README ("consumer" → "sink") fails the spec until the spec follows.

---

## 3. Visual language

### 3.1 Five rules

1. **The stage reads top to bottom: who runs, what they share, what the test sees.** Goroutine and channel rows go in data-flow order. Facts follow. Tests are always last.
2. **Color marks health, not state.** Running is calm. Parked is attention, not failure. Red is reserved for an outcome that is wrong: a failed test, a leak, a deadlock, a panic, a broken limit.
3. **Color marks shapes; text stays neutral.** Discs, bars, borders, and token fills carry color. All text is `--fg` or `--fg-muted`. Contrast is then never a per-spec problem.
4. **Only tokens move.** A value travels from a goroutine into a slot and out to another goroutine. Nothing else animates beyond a short fade.
5. **The eye goes to what changed.** Every row whose state changed in this step gets a ring for the whole step. This works with motion off.

### 3.2 Stage anatomy at the 216 px floor

The figure has a 1 px border and 8 px padding, so the inner width is **198 px** at the floor and 270 px on a 320 px phone. Every budget below is set by the floor.

```
┌─ figure 216 px ─────────────────────────────┐
│ (Diagram) (Today) [Goal]            4 / 6   │ A  scene chips, a radiogroup        28 px
│ ⏮  ◀  ▶  ▶|                     t 100 ms    │ B  transport, 32 px icon buttons    32 px
│ 0 ─────── 100┊────150┊──────────── 600 ms   │ C  clock strip (only with a clock)  30 px
│          deadline  budget                   │
├─────────────────────────────────────────────┤
│▌‖ producer          send 3 → ch       [3]   │ D  rows, 28 px each, 2 px gap       ≤ 6 rows
│ ┄  []T                     not used         │    (ghost row, 50 % opacity)
│    ch  cap 2               [1][2]  →        │
│ ●  consumer         consume           [0]   │
│    gap   3  ▕██████░░░░▏ ≤ 5                │
│    tests  … all items   … backpressure      │
├─────────────────────────────────────────────┤
│ produce(3) finds both slots full, so the    │ E  caption, 13 px, min 2 lines
│ producer waits on ch.                       │
│ ▸ One possible schedule                     │ F  transcript summary (§7, decision 9)
└─────────────────────────────────────────────┘
```

| Zone | Rule |
| --- | --- |
| A | Chips are the scene names, ≤ 8 characters ("Today", "Goal", "Trap", "Fixed", "Leak"). The step counter sits at the right. There is no separate title line; the doc already has a heading. |
| B | Four icon buttons, 32 × 32, each with `aria-label` and `title`: Restart, Step back, Play/Pause, Step. Total width 140 px. They never wrap. The clock readout sits at the right when the scene has a clock. The transport is above the stage, so caption length never moves it. |
| C | Linear scale from 0 to `clock.end` across the row width. At most two marks, named ≤ 8 characters, labels on alternate lines. Hairlines run down through all goroutine rows. |
| D | One row per cast member that the tier shows. See the row table below. |
| E | One or two sentences, ≤ 120 characters, present tense. It names the actor and the act. |
| F | One line. The browser note and the full step list live in the `<details>` transcript. The current five-line note costs about 100 px on every frame. |

**Rows (198 px).**

| Row | Layout, left to right |
| --- | --- |
| Goroutine | 3 px status bar (wait or fail color when parked) · 10 px glyph · 4 px · name, 12 px mono, ≤ 10 characters · flex · op text, 11 px, ≤ 12 characters, right-aligned · 4 px · held token, 20 px. With a clock: a 3 px history underline at the row bottom, running segments in accent and parked segments in the wait color, past segments at 60 % opacity. |
| Goroutine group | Name with "×10" · a strip of one 8 px disc per instance (running, parked, exited). The row's sentence counts each state. |
| Channel | Name, 12 px mono · "cap 2", 10 px muted · flex · slots of 20 × 20 px with 3 px gaps, receive order left to right (the leftmost token leaves next) · a 10 px exit tick "→". An empty slot has a dashed border. Unbuffered: two facing 1.5 px brackets 8 px apart; a token sits between them only during a hand-off. Closed: a diagonal slash through the slots and the word "closed". More than 5 slots: the first 4 and "+n". |
| Meter | Name · value, 12 px mono 600 · a 60 px bar · the limit "≤ 5". Past the limit, the bar and the limit turn `--fail`. |
| Tests | One chip per test: glyph plus short name. Two chips per line at the floor. |
| Lamp | Glyph plus the `on` or `off` word. |

### 3.3 Tokens, type, color, glyphs, motion, density

**Type.** Four sizes, two weights. Nothing below 10 px.

| Size | Face | Use |
| --- | --- | --- |
| 13 px | `--sans` | Caption |
| 12 px | `--mono` | Row names, meter values |
| 11 px | `--sans` | Op text, chips, test names |
| 10 px | `--mono`, tabular figures | Token numbers, clock ticks, "cap 2" |

**Color roles.** One new token, `--viz-wait`. Everything else is an existing site token.

| Role | Token | Light | Dark | Marks |
| --- | --- | --- | --- | --- |
| Run | `--accent` | `#007d9c` | `#00add8` | Running glyph, token border, change ring |
| Wait | `--viz-wait` (new) | `#8a5a00` (5.24 : 1 on `--bg-sunken`) | `#d29922` (6.60 : 1 on `#1e1e1e`) | Parked glyph, the 3 px status bar, parked underline |
| OK | `--pass` | existing | existing | Test pass, outcome pass |
| Wrong | `--fail` | existing | existing | Test fail, parked forever, deadlock, panic, a meter past its limit |
| Quiet | `--fg-muted`, `--border` | existing | existing | Exited, ghost rows, empty slots, axis |
| Surface | `--bg-elev` rows on a `--bg-sunken` figure | existing | existing | — |

Define `--viz-wait` in all three theme blocks of `styles.css` (`:root`, the dark media query, `[data-theme="dark"]`).

**Glyphs.** Inline SVG, 10 × 10, from `kit/glyphs.tsx` only. Each glyph always appears with a word in the row's sentence.

| State | Glyph | Color |
| --- | --- | --- |
| Running | Filled disc | Run |
| Parked | Two vertical bars | Wait |
| Parked forever (end of a `leak` or `deadlock` scene) | Two bars inside a ring | Wrong |
| Exited | Hollow disc | Quiet |
| Not started (ghost row) | Dotted ring, row at 50 % opacity | Quiet |
| Panicked | Cross | Wrong |
| Token | 20 × 20 rounded square, 1.5 px border, `--accent-soft` fill, ≤ 3 characters | Run |
| Dropped token | Token with a strike, then gone next step | Quiet |
| Test pass / fail / pending | Check / cross / ellipsis | OK / Wrong / Quiet |

**Lines.** The stage draws no free arrows. Each relation is named in text at both ends: the goroutine says "send 3 → ch", and the channel says "1 waiting". The only lines are the clock hairlines (1 px dashed, `--fg-muted`) and the channel exit tick.

**Motion.**

| What | How | Reduced motion |
| --- | --- | --- |
| A token moves | FLIP with `element.animate`: translate from the old box to the new box, 240 ms, `cubic-bezier(.2, .7, .2, 1)`. No library. | Appears in place. |
| `repeat` fills | Tokens stream in with a 30 ms stagger. | Appear at once. |
| Glyph or bar color changes | 120 ms cross-fade | Instant |
| Change ring | 2 px `--accent` outline, 1 px offset, for the whole step | Same |
| Play pace | 1400 ms per step; `beat: "long"` gives 2400 ms | Starts paused |
| Never | Loops, pulses, bounces, autoplay, speed hacks | — |

**Density budgets** (checked by viz-check):

| Budget | Limit |
| --- | --- |
| Rows per scene (a group row counts as one) | 6 |
| Steps per scene (use `repeat` for loops) | 8 |
| Scenes per tier | 3 |
| Chip | 8 characters |
| Row name | 10 characters |
| `work` text | 12 characters |
| Test short name | 14 characters |
| Caption | 120 characters |
| Visible slots per channel | 5 |
| Clock marks | 2 |

### 3.4 The canonical scene: 18 "Goal"

This scene uses every core rule: a goroutine that parks without alarm, a channel with token identity, the hand-off that is the lesson, a meter with a limit, and tests.

| Step | Ops | What the stage shows |
| --- | --- | --- |
| 1 | `go` ×2, `recv(consumer, ch)` | producer ● running; consumer ‖ parked, "recv ← ch"; `[]T` is a ghost row; ch is empty. |
| 2 | `send(producer, ch, 0)` | Token 0 travels from producer *past* the empty slots straight to consumer. consumer ● "consume" holds [0]. gap 0. |
| 3 | `send` 1, `send` 2 | Tokens 1 and 2 travel into the slots. gap 2. |
| 4 | `send(producer, ch, 3)` | producer gets the wait bar and ‖, "send 3 → ch", and holds [3]. The channel shows "1 waiting". gap 3. |
| 5 | `recv(consumer, ch)` | **The lesson.** Token 1 slides from slot 1 to consumer. Token 2 slides one slot left, because the leftmost token leaves next. Token 3 slides from producer into the free slot. producer returns to ●. Three rings (§7, decision 10). |
| 6 | `close`, `drain`, `pass` ×2 | ch shows "closed". Both goroutines exit. Both tests pass. gap stays 3. |

Frame 4 and frame 5 at 198 px:

```
 frame 4                                   frame 5
│▌‖ producer     send 3 → ch   [3]│      │ ●  producer     produce       │ ring
│ ┄  []T              not used    │      │ ┄  []T              not used  │
│    ch  cap 2        [1][2]  →   │      │    ch  cap 2        [2][3]  → │ ring
│ ●  consumer     consume      [0]│      │ ●  consumer     consume    [1]│ ring
│    gap   3  ▕██████░░░░▏ ≤ 5    │      │    gap   3  ▕██████░░░░▏ ≤ 5  │
│    tests  … all items  … backp. │      │    tests  … all items  … back.│
```

The same stage in the "Today" scene shows `[]T` as a dense strip that fills with 20 ticks in one `repeat` step, ch as a ghost, and gap climbing to 19 past the limit, with the bar in red. Switching Today ⇄ Goal moves no row. The learner sees one difference: a pile in memory versus two slots and a parked producer.

### 3.5 The time variant: 31 "Today"

Cast: `Serve` (goroutine), `ctx` (context, deadline 100), `tests`. Clock 0–600 ms, marks `deadline` 100 and `budget` 150.

```
│ ⏮  ◀  ▶  ▶|                       t 150 ms │
│ 0 ────────── 100┊─150┊────────────── 600 ms│
│             deadline budget                │
│ ●  Serve              in handler()         │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ (underline to 150)
│    ctx      Done closed · 0 listening      │ ring was here at 100 ms
│    tests    … deadline                     │
```

The author writes only `t: 100`. The fold closes `ctx.Done` because the deadline passed, and it counts zero listeners. "The deadline nobody reads" becomes a fact of the model, not a caption. This replaces the two caption-only steps at `31-serve-timeout-race.ts:22-31`.

### 3.6 The 04 board, reworked

The current board stacks four groups of identical chips (process, mailbox, tests, signals), with no cause and effect. In the kit:

| Scene | Tier | Cast used | The picture at the end |
| --- | --- | --- | --- |
| Today | `today` | `main` "proc.Run()", process lamp, tests | `kill("Ctrl-C: no handler")`: every row exits, the lamp is off, the graceful test fails. |
| Goal | `goal` | `main`, `stop` "Stop()", process lamp, Ctrl-C meter, tests | First Ctrl-C: Stop() starts and never ends, the lamp stays on. Second Ctrl-C: `kill`. Both tests pass. No channel row, because the README names none. |
| Trap | `inside` | adds `sigChan` cap 2 | main is ‖ "in Stop()". A "sig" token sits in sigChan with "0 listening". The second test fails. The stuck token *is* the explanation. |
| Fixed | `inside` | adds `stopped` cap 0 | main parks in `select` on both channels. The second `signal` wakes main through the sigChan case. `kill("os.Exit(1)")`. Both tests pass. |

Because `recv` and `select` park main, the "waiting counted as running" bug (F2) cannot occur. Because `stop` starts with a `go` op after the first signal, the "Stop at t = 0" bug is visible in review.

---

## 4. Placement and UX

### 4.1 Decision: the README diagram is the door

The visual opens on the diagram the learner is already reading. It is not a panel at the end, and it is not a third tab.

- **Default view:** the README's own ASCII diagram, exactly as GitHub shows it.
- **Under the diagram:** a slim bar, attached to the fence: `▶ Watch  (Today) (Goal)`.
- **Press a chip:** the stage replaces the `<pre>` in place, at the same top edge. The chip row gains "Diagram" to swap back. Nothing scrolls.
- **Why replace, not append:** at 216 px a README `<pre>` shows about 25 columns; the 04 diagram is 87 columns wide and scrolls sideways. The stage is the better narrow view, and replacing does not double the height.
- **Deep link:** `#watch-goal` opens the door on that scene.

**Why not a third tab.**

| Reason | Artifact |
| --- | --- |
| The tab row already needs about 307 px with two tabs and both badges, and about 367 px with a third tab. The pane floor is 260 px. | `docs/visualisation-handoff.md:673` |
| A tab separates the picture from the words it explains. | — |
| Only some exercises would have the tab, so the chrome changes per exercise. | 3 of 43 have specs today |
| Fix scenes in a tab need a second reveal gate, or a lifted one. | `DocPane.tsx:18` keeps `revealed` local |

### 4.2 Where each scene appears, and when

| Moment | Learner state | Where | What | Gate |
| --- | --- | --- | --- | --- |
| Reading the task | Before any code | Problem tab, on the pinned README diagram | Today, then Goal | None; the vocabulary and spoiler rules guard it |
| A test fails (phase 3) | Stuck | A "See why ▸" link beside a failing test that the spec's `tests` row names | Opens the door on Today, step 1 | None |
| The browser cannot run the exercise (04) (phase 3) | No feedback at all | Beside the runner's "cannot run here" note: "Watch it instead ▸" | Opens the door on Today | None |
| After the reveal | Wants the reasoning | Solution tab, at the top of the revealed write-up | Inside scenes: mechanism and traps | The existing `revealed` state |

### 4.3 The spoiler boundary

**The Problem tab may show what the README already says. The Solution tab shows how and why.**

The README diagrams already draw the goal: "1st Ctrl-C ──▶ proc.Stop()" in 04, "ch (small, fixed cap)" in 18, "whichever lands first wins" in 31. A `goal` scene animates that drawing at the same level of detail. Two mechanical rules hold the line:

- **Vocabulary:** every `today` or `goal` row label occurs in the README.
- **Spoilers:** no `today` or `goal` text contains an identifier that appears in the solution doc's code but nowhere in the README or the committed scaffold. Identifiers count when the solution code declares them (`x :=`, `var x`, `func x`), when they are camelCase or contain `.` or `_`, or when they are Go keywords and builtins (`select`, `close`, `make`, …). Plain English that the README already uses ("results" in 06) is allowed. A spec may allow a word with `spoilerOk: { word: "reason" }`.

Goal scenes reach the Problem tab only after these two rules pass in viz-check (§7, decision 1). Until then `GOAL_IN_PROBLEM` stays `false`.

### 4.4 Widths

| Case | Content width | Figure inner width | Holds |
| --- | --- | --- | --- |
| 260 px pane floor | 216 px | 198 px | Every budget in §3.3 is set here. |
| 320 px phone | 288 px | 270 px | Rows gain room; nothing reflows. |
| Wide pane | > 288 px | Up to 480 px, then centered | The stage does not stretch past 480 px; long rows are harder to read. |

Change the figure padding from 12 px to 8 px (`styles.css:1097`).

### 4.5 Keyboard and screen readers

| Input | Action (while focus is in the figure) |
| --- | --- |
| Tab | Chips (one stop, a radiogroup), then the four transport buttons, then the transcript |
| ← / → in the chips | Change the scene |
| ← / → elsewhere | Step back / Step |
| Space | Play / Pause |
| Home / End | First / last step |

- Rows are real text, not `aria-hidden`. Each row has a sentence from its kind's `text()`, for example "producer is parked: send 3 on ch".
- The caption is announced through `aria-live="polite"` on a step and stays silent while playing (keep `VizPlayer.tsx:121`).
- The figure's `aria-label` is the scene `summary`.

### 4.6 Reduced motion

Start paused. No token travel, no fades. The change ring stays, so the learner still sees what changed. Play still works; it jumps between frames.

---

## 5. The dumb-agent walkthrough: exercise 06

The agent has never seen the visualiser. It opens `06-fan-out-fan-in`.

| # | The agent does | File or command | Decision it makes | Guard that catches a mistake |
| --- | --- | --- | --- | --- |
| 1 | Reads the `new-visualisation` skill, linked from the AGENTS.md "Common tasks" list | `.claude/skills/new-visualisation/SKILL.md` | — | — |
| 2 | Applies the gate question: does the lesson depend on *when* something blocks, *which* goroutine is parked, or *what* keeps running? | `06-fan-out-fan-in/README.md` | Yes: ten 150 ms calls run end to end instead of overlapping. | — |
| 3 | Confirms the README has a saved today/goal diagram | README | The 06 diagram is new and uncommitted today. That is fine locally, but it must be committed before deploy. | CI `make lint` fails on `HEAD` until the README is committed. |
| 4 | Runs the generator | `npm run viz -- new 06-fan-out-fan-in` | It writes `specs/06-fan-out-fan-in.ts` from the template, with `exercise` and the `diagram` pin filled in. | If the README has two diagram fences, the command stops and asks for `--fence N`. |
| 5 | Fills `constants` from the code | `mockimageprocessor.go`, `check_test.go` | `latency: 150, "ProcessingLatency = 150"`; `budget: 500, "budget = 500"`; `urls: 10, "10 * ProcessingLatency"` | viz-check: the text must occur in the file and contain the value. |
| 6 | Writes the cast from the diagram's own words | spec | `caller` (goroutine), `workers` (goroutine, `count: 10`, label "worker", tier `goal`), `fanin` (channel, cap 0, label "fan-in", tier `goal`), `thumbs` (cells, label "Thumbnail", size 10), `elapsed` (meter, unit ms, limit 500), `tests`. Clock 0–1500 ms, mark `budget` 500. | Vocabulary rule: every label occurs in the README. Name budget: ≤ 10 characters ("[]Thumbnail" is 11, so it uses "Thumbnail"). |
| 7 | Writes **Today** in 3 steps | spec | Step 1 `t: 0`: caller works "ProcessImage". Step 2: `repeat(10, …)` fills `thumbs` one by one and moves the clock to 1500. Step 3: `fail("tests.timing")`, outcome `fail`. | Step budget 8; caption budget 120; "1.5 s" passes because it equals the clock at that step. |
| 8 | Writes **Goal** in 4 steps | spec | `go("workers[*]")` at `t: 0`; each works "ProcessImage"; at `t: 150` each sends into fan-in while caller receives and fills `thumbs`; `pass`, outcome `pass`. | If the agent writes ten sends without ten receives, the fold parks nine workers and the outcome check fails with the hand-off message in §2.5. |
| 9 | Writes **inside** scenes | spec | "Fixed": close after `wait(wg)`. "Close early": a worker closes too soon, a later send panics, outcome `panic`, and the caption says "one possible schedule". Each inside scene may set its own clock (0–300 ms) to zoom. | `close` then `send` produces the panic in the fold; a mismatched outcome fails. |
| 10 | Runs the checks | `npm run check-visuals -- 06` | Fixes each message. A typical first run: `06/goal step 3: "wg.Wait" appears only in solutions/06-fan-out-fan-in.md:94`. The caption said "wg.Wait returns, so fan-in closes". The agent moves that step to the inside "Fixed" scene and keeps Goal in the README's words. | viz-check |
| 11 | Runs the model tests | `npm run test-visuals` | No change expected; it touched no kit code. | A failure here means the agent edited the kit; the skill says to revert. |
| 12 | Runs the pixel check (phase 3) | `npm run viz -- shots 06` | Opens the eight PNGs and applies the caption-off test. | Overflow, truncation, tap size, figure height |
| 13 | Runs lint | `make lint` | — | `viz-diagram` proves the pin against the README. The stop guard runs this too. |
| 14 | Commits by explicit path | `git add web/src/viz/specs/06-fan-out-fan-in.ts` (and the README, if changed) | — | The commit gate: lint, staged README with no newer unstaged edits, and the pin against the staged README. |

**Files touched:** one spec file, plus the README only if the diagram changed. No registry line, no player, no CSS, no test file.

**If the kit lacks something** (for example, 06 wanted a "concurrency dial"), the agent stops and reports the missing primitive. It does not add a control to the player.

---

## 6. Prioritized plan

### Phase 1 — the kit and the canonical stage

**Build.** `kit/model.ts`, `kit/run.ts` with goroutine, channel, `select`, `signal`, context and clock, wait group, `kill`, `repeat`, `drain`; the kinds `goroutine`, `channel`, `cells`, `meter`, `lamp`, `tests`; `Stage.tsx`, `glyphs.tsx`, `--viz-wait`, the type scale, the transport row, the scene chips, FLIP token motion, the change ring; viz-check semantic checks, budgets, per-file anchors, and constants (text contains value); `viz-kit.test.ts`. Migrate 04, 18, and 31 to schema 2, and fix the two 04 story bugs (§3.6). Delete the v1 views and tests.

**Accept when:**

- 18 Goal step 5 moves two tokens at once, in light and dark, at 216 px.
- All three pilots fit 216 px with no truncated text; the transport stays one 32 px row; each figure is ≤ 420 px tall (today: 404–636 px).
- A parked goroutine is never red unless the scene ends parked in a `leak` or `deadlock`.
- A kit test proves that a send to a parked receiver hands off and does not buffer.
- Reduced motion starts paused and moves nothing; the ring still shows.

**Cut:** the clock underline polish, group rows, `mutex`, `machine`, `viz-shots`, the console link, deep links.

### Phase 2 — the door, the sync, and the contract

**Build.** `kit/diagramHash.ts` and the Go twin with one shared fixture; the `viz-diagram` lint rule; `markdown.ts` stamps fences; `VizDoor` in the Problem tab and the Solution tab; the dev stale strip and production fail-closed; tiers `today`, `goal`, `inside`; the vocabulary and spoiler rules; `npm run viz -- new|pin`; `_template.ts`; the `import.meta.glob` registry; the `new-visualisation` skill, its `.agents` symlink, and one AGENTS.md row. Then run a **dry run**: a fresh subagent with only the skill builds 06.

**Accept when:**

- One changed character in the 18 README diagram fails `make lint` with the pin message, and the dev page shows the stale strip.
- The Problem tabs of 04, 18, and 31 show the door on their diagrams; keyboard-only use works end to end.
- The dry-run agent produces a 06 spec that passes every check without asking a question, and the owner accepts it with content feedback only.

**Cut:** solution-heading anchors (mount at the top of the solution), auto-filled constants, deep links.

### Phase 3 — scale and polish

**Build.** `npm run viz -- shots` over CDP (216 and 288 px, light and dark) with overflow, truncation, tap-size, and height assertions; the "See why ▸" console link and the "Watch it instead ▸" link for 04; the kinds Tier B needs (`mutex` with a linearized ring for 21, `machine` for 22, group rows for 06); then the Tier B specs (06, 08, 13, 21, 22, 27, 28, 29), each written by a subagent from the skill alone.

**Accept when:** eight Tier B specs merge with zero edits to the player, the stage, or the CSS, and each passes every check.

**Cut:** Tier C and Tier D exercises, the third tab, a heap tree view.

---

## 7. Decisions

On 2026-11-05 the owner gave these decisions to the design reviewer. They are final. The implementer does not choose a default for a design question. It asks the reviewer, and the reviewer records the answer here. **Where this section conflicts with an earlier section, this section wins.**

### 7.1 Before Phase 1

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 1 | Goal scenes in the Problem tab? | **Yes, after Phase 2 adds the guard.** | Keep `GOAL_IN_PROBLEM = false` until the vocabulary and spoiler rules (§4.3) are in viz-check and pass for 04, 18, and 31. Then set it to `true` in the same commit. Until then, goal scenes render in the Solution tab. Reason: the README diagram already draws the goal, so a guarded goal scene shows nothing new. Without the guard, one careless word would spoil the exercise. |
| 2 | A third tab? | **No.** | The door on the README diagram (§4.1) is the only home for Problem scenes. Do not build `"visualisation"` in `Route.tab`. Reason: the tab row needs about 307 px against a 260 px floor, and a tab separates the picture from the words it explains. |
| 3 | `--viz-wait` amber for parked goroutines? | **Yes.** | Use `#8a5a00` in light (5.24 : 1 on `--bg-sunken`) and `#d29922` in dark (6.60 : 1 on `#1e1e1e`). Use it on shapes only, never on text. Reason: gray hides the one state most lessons turn on, and red says "broken" when parking is correct. |
| 4 | Default view at the door? | **The README's ASCII diagram.** | The scene opens only when the learner presses a chip. Reason: the site then shows exactly what GitHub and a clone show until the learner asks for more, and the page never changes on its own. |
| 5 | "See why ▸" link from a failing test? | **Yes, in Phase 3.** | Scope: the console shows a link beside a failing test whose full name appears in a spec's `tests` row. The link opens the door on Today, step 1. It reads test names from the output that already exists. It must not change how the runner builds or runs code. Add "Watch it instead ▸" beside the "cannot run here" note for 04 at the same time. |
| 6 | Where do fact kinds live? | **In `kinds/<kind>` modules behind a registry, from Phase 1.** | Runtime kinds (goroutine, channel, mutex, wait group, context) stay closed in `run.ts`. Fact kinds (cells, meter, lamp, machine, tests) each export `init`, `apply`, `Row`, `text`, and `check`. See §2.4. Reason: the first build put fact kinds in `model.ts` unions and in `switch` statements in `run.ts` (`setFact`, `addTo`). Then every new kind edits the core, and the promise "a new kind is one file" breaks. This is cheapest to fix while those functions are about 80 lines. |
| 7 | One verb, one meaning for facts | **`add` only grows a number. Cells get `push` and `put`.** | `add(id, n)` applies to a meter or a wait group. `push(id, v)` appends to cells, and `put(id, i, v)` writes slot i. Remove `set(cells, count)`, which invents index tokens; write `repeat(n, (i) => [push(id, i)])` instead. Reason: in the first build, `add("thumbs", 3)` appended a token 3 while `add("gap", 3)` added 3. A spec author cannot see that difference. `put` also models 06's indexed fan-in (`thumbnails[idx] = …`) and shards. |

### 7.2 From the Phase 1 pixel pass

The implementer measured Phase 1 at 216 and 288 px, light and dark (`/tmp/viz-phase1/report.json`, 53 screenshots), and raised 21 questions. Decisions 8–28 answer them in order.

**Height, chrome, and text**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 8 | Height: 420 or 360 px? | **420 px at 216 px binds.** | 360 is a stale draft number; delete it wherever it appears. Remove the fixed four-line caption reserve; the caption's minimum height is two lines. Reason: the transport sits above the stage, so a taller caption moves only the footer, never a control. The screenshots show 30–50 px of empty space under every caption. |
| 9 | The transcript label truncates (218 px in 196 px). | **The summary reads "One possible schedule".** | The open transcript starts with "Scripted model, not a trace of your code." and then the browser note. The summary may wrap. Nothing in the figure ever truncates: ban `text-overflow: ellipsis` in the viz CSS. |
| 10 | 18 Goal step 5 moves three tokens, not two. | **Accept the packed shift.** | The leftmost token always leaves next, so after a receive the rest slide left: 1 goes to the consumer, 2 slides left, 3 enters. §3.4 was wrong to say two. Fixed ring positions would put 3 to the left of 2 and break receive order. |
| 11 | 04 Trap: main is inside `Stop()` and renders running. | **Add `work(g, text, { forever: true })`. No `block` verb, no "no reader" mark.** | main *is* running: the mock's `Stop()` loops and never parks. A `block` verb would let a spec declare a state the model cannot check, which reopens F2. `forever` marks a call that never returns. The row stays running and its text gets the word "forever". Any later op on that goroutine is an error. At the end of a `fail` or `leak` scene its rail turns `--fail`, because it is the cause. A `pass` outcome with a live `forever` goroutine is an error unless `kill` ended it. A "no reader" mark on the channel would lie: a buffered token with no parked receiver is normal (18 step 4). |
| 12 | 04 Fixed has 7 rows; the budget is 6. | **Ghost rows exist only in Problem scenes. The 6-row budget applies to every scene and counts the tests row.** | Ghost rows serve the Today ⇄ Goal comparison. Inside scenes render exactly the rows they use. 04 Fixed drops the Ctrl-C meter, because the sigChan tokens already show each signal; that leaves 6 rows. 04 Trap loses its "Stop()" and "stopped" ghost rows. |

**Verbs**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 13 | May `put(id, i, v)` leave lower slots empty? | **Yes.** | `put` may write any index below `size`; empty slots render empty. 06 fills results in completion order. `push` appends after the highest filled slot, like `append`. One cells row uses only `push` or only `put` across the whole spec; viz-check rejects a mix. |
| 14 | May `add` take a negative n? | **Yes, for a meter and a wait group.** | `wg.Add(-1)` is legal Go. A wait group below zero still panics. |

**Stage details**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 15 | The verdict strip | **Only for `leak`, `deadlock`, and `panic`.** | These are the outcomes a tests row cannot show. The fold writes the text: "Leak: handler parked forever on resCh", "Deadlock: P1 → P2 → P1", "Panic: send on closed channel results". It is the last line of the stage, on the final step only, and does not count toward the row budget. `pass` and `fail` scenes get no strip; the 31 Today frame shows "✕ fail" directly under "✕ deadline", which says the same thing twice. |
| 16 | Meter limit text in red? | **No. Only the bar turns `--fail`.** | The limit text stays `--fg-muted`. The comparator is derived: "≤ 5" within the limit and "> 5" past it, so the state reads without color. |
| 17 | Lamp | **Confirmed.** | On: a filled accent disc and the `on` word. Off: a hollow muted disc and the `off` word. |
| 18 | Test marks as CSS text | **No. Make the glyphs a Node-loadable module.** | Move `kit/glyphs.tsx` to `kit/glyphs.ts`: path data plus a `glyph(name)` function built with `createElement`, with no JSX. The stage and every kind's `Row` use it, so Node checks can load any kind. Delete `glyphs.tsx` after the move. |
| 19 | Select row text | **Parked: "select (2)". On wake: "← sigChan" or "→ ch".** | Each case channel shows "1 waiting". In the step where a case wins, the goroutine's text is derived from that case (`←` for a receive case, `→` for a send case) until its next op, and the winning channel rings. The row's screen-reader sentence lists every case. This is the moment a select lesson is about. |
| 20 | Clock strip height | **30 px.** | A scale line plus two label lines, so two marks never collide. Zone C in §3.2 is 30 px. |

**Spec and contract**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 21 | 18 has two diagram fences. Which owns the door? | **Each Problem tier pins its own fence.** | Replace `diagram: string` with `diagrams: { today: string; goal?: string }`. 18 gets `today: "fnv1a:a6cf25d7"` and `goal: "fnv1a:9ad63bf8"`: two doors, each with its own chip plus "Diagram", each next to the prose it illustrates. 04 and 31 draw both states in one fence, so both pins are equal and one door has two chips. `viz-diagram` checks every pin. Change the type in Phase 1; mounting stays in Phase 2. |
| 22 | `kill` rings ghost rows | **`kill` exits only goroutines that have started. Ghost rows never ring.** | An idle goroutine stays idle after `kill`. |
| 23 | Vocabulary: README only, or README and scaffold? | **Split by row type.** | Flow rows (goroutine, channel, mutex, wait group, context, cells) use README words only, because they are what the diagram draws. Fact rows (meter, lamp, machine, tests) may also use words from the committed test and mock files, because they report what the tests measure. 18's "gap" stays: `check_test.go` has `gapAtProduce`. |
| 24 | 31 Handler marks the 500 ms deadline test as passed | **Not intended. A tests row shows only the tests its scene marks.** | A chip appears for each test the scene passes or fails, and it shows pending until that scene marks it. 31 Handler wins adds and marks `TestServeReturnsHandlerResultWithAmpleDeadline` (`31-serve-timeout-race/check_test.go:24`), short name "ample time". It does not mark the deadline test. |
| 25 | `aria-live` while playing | **Silent while playing; announce on pause, at the end, and on every manual step.** | The visible caption always shows its text. The live region is a separate visually hidden node. At 1.4 s per step, spoken captions would overlap. |
| 26 | Focus at a scene boundary; Space | **Never use `disabled` on transport buttons. Native activation wins for Space.** | Use `aria-disabled="true"` and ignore activation, so focus stays in the figure. Space on a focused button activates that button. `K` toggles Play/Pause anywhere in the figure. ← / → / Home / End step anywhere in the figure except the chips, where ← / → change the scene. |
| 27 | Ring scope | **The caption names every ringed row, or the step does too much.** | viz-check: at most 3 rings per step. `kill` rings only the process lamp; rows that exit because of `kill` change their glyph without a ring. A step that marks a test must say "pass" or "fail" in its caption. 04 Goal step 2 ends "…so the first test passes." |
| 28 | Row order, and which checks land in Phase 1 | **For ordering, cells is a flow row.** | Order: flow rows in data-flow order (cells included, because a slice sits in the data path), then meter, lamp, and machine, then tests last. §3.4's frame is correct. Phase 1 checks: cast order, caption numbers, and an optional per-file `anchors: { file, text }[]` field. `spoilerOk` arrives with the spoiler rule in Phase 2. |

### 7.3 Phase 1 review

**Verdict: accepted once decisions 31–34 are fixed.** Phase 2 may start then. The reviewer re-ran the checks: `tsc` is clean, `check-visuals` passes 3 specs, 43 of 43 kit tests pass, and `make lint` is ok. The final report (`/tmp/viz-verify2/report.json`, 44 captures) shows a tallest figure of 397 px at 216 px, no truncated text, and no transport wrap. The code holds the rules that are easy to break: no `disabled` attribute, no `ellipsis` in the viz CSS, `glyphs.ts` only, the verdict strip only for leak, deadlock, and panic, `GOAL_IN_PROBLEM = false`, and a glob registry. The 04 Trap and 31 Leak end frames carry their lesson without the caption.

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 29 | A deadlock with no wait-for cycle (two receivers parked on one empty channel) | **Keep it. It is a real deadlock.** | Go's runtime reports it as "all goroutines are asleep - deadlock!". Do not fail the scene. The strip reads "Deadlock: all goroutines wait — a ← ch, b ← ch", with the same arrows as the row text (← receive, → send). When a wait-for cycle exists, the strip names the cycle instead. The first build wrote "a → ch" for a receive, which contradicts decision 19. |
| 30 | A leak with more than one parked goroutine | **Group, then name at most two.** | Members of one group that wait on the same target collapse: "Leak: workers ×9 parked forever on fan-in". Otherwise name the first two and add "+N more". The strip may wrap to two lines; the transcript lists every parked goroutine. The text is derived, not authored, so the 120-character caption budget does not apply, but nothing truncates. |
| 31 | 18 Today draws two goroutines | **Must fix. One row is one goroutine across every scene. Name a row by who it is, not by its role in one scene.** | The scaffold runs both loops on the caller's goroutine (`18-bounded-pipeline-backpressure/main.go:54-62`), so "producer" and "consumer" in Today invent a goroutine. Cast: `producer` (tier `goal`), `[]T`, `ch` (tier `goal`), `caller` (README word, `README.md:26`), `gap`, `tests`. Today: `caller` produces into `[]T`, then consumes; `producer` is a ghost. Goal: `producer` sends into `ch`, and `caller` ranges over it with the work text "consume". The "consumer" row in §2.3 and §3.4 reads `caller` from now on. Add this rule to the skill. |
| 32 | 31 uses two `tests` rows | **Must fix. One `tests` row per spec.** | Decision 24 already hides any test a scene does not mark, so a second row only spends the 6-row budget. Merge `testsDeadline` and `testsAmple`. Delete the skill line "If two scenes mark different tests, give each its own `tests` row." |
| 33 | The skill names a guard that does not exist | **Must fix. The skill names only guards that exist.** | Step 5 says "`viz-diagram` checks every pin", but no rule of that name is in `tools/check` or `viz-check.ts`. Write: "`npm run check-visuals` checks every pin against the README. The `make lint` rule `viz-diagram` arrives in Phase 2." |
| 34 | The new commit-gate rule refuses every commit while any exercise README has unstaged changes | **Must fix. Scope it to the exercises the commit touches.** | Refuse only when the commit stages a file under `<id>/`, `solutions/<id>.md`, or `web/src/viz/specs/<id>.ts` while `<id>/README.md` has unstaged changes. The global rule (`tools/check/hook.go`, new block in `runPrecommit`) blocks every unrelated commit today, because 13 exercise READMEs in the owner's checkout have unstaged edits. The scoped rule still stops the real fault: a spec pinned to a diagram that the commit leaves behind. Update the commit-gate row in `AGENTS.md` to match. |

**Phase 1 is accepted** (re-check after decisions 29–34: `tsc` clean, 3 specs pass, 46 of 46 kit tests, lint ok; the 31 spec has one `tests` row; the commit rule is scoped and `AGENTS.md` matches; the skill names no missing guard). One defect remains. It is decision 35, and it is the first change of Phase 2.

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 35 | 18 Today's last step: the caption says "The caller now runs consume", but the row shows "exited" | **Every op's effect must be visible at the end of its step. viz-check rejects a dead op.** | The step runs `work("caller", "consume")` and `exit("caller")` together, so the exit replaces the work text before the frame renders. Split 18 Today into four steps: "The caller now consumes the items one by one." (`work`), then the exit with `pass` and `fail`. The check: within one step, a `work(g, …)` followed by `exit(g)`, `kill`, or another `work(g, …)` is an error that says "the work text never shows; split the step". |
| 36 | When does `GOAL_IN_PROBLEM` turn on? | **In the commit that ships the door, after a planted spoiler fails.** | `check-visuals` already lists the vocabulary and spoiler rules, so the condition of decision 1 is close. Prove it first: a test plants a solution-only identifier (for example `sigChan`) in a goal caption and a solution-only label in a goal row, and both must fail. Then turn the gate on in the same commit as the door, so goal scenes appear on the README diagram and never in the end-of-README panel. |

### 7.4 Phase 2 questions and the 06 dry run

Phase 2 reached: 55 of 55 tests, the Go hash and lint rule, the door, the CLI, decisions 35–36, a lint failure for one changed character in the 18 diagram, keyboard-only door use, the dev stale strip, and production fail-closed. A fresh agent wrote `web/src/viz/specs/06-fan-out-fan-in.ts` from the skill alone. The reviewer read that spec and the 06 tests.

**Blockers**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 37 | 06 fails `check-visuals` because its README diagram is not committed | **`check-visuals` checks pins against the working-tree README only.** | This is §2.6 step 6: check what you render. The extra failure "the HEAD README carries a diagram" becomes a warning that names the README the commit must include. A commit is still guarded: `viz-diagram` compares the staged README, the scoped commit rule (decision 34) refuses a spec whose README is unstaged, and CI checks `HEAD`. Committing the 06 README is the owner's decision; no agent commits without the owner's request. |
| 38 | The 06 Goal stage is 221 px wide at the 216 px floor | **Build the group row now, as §3.2 specifies.** | The name and "×N", then one 8 px disc per member with 3 px gaps, up to 10 members. From 11 to 16 members, the discs are 6 px with 2 px gaps. Above 16, counts only: "12 running · 4 parked". A group row shows no work text; the shared text goes into the row's sentence and the caption. The row must fit 198 px. |

**The 06 spec**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 39 | Today ends at 1500 ms and Goal at 500 ms | **Problem scenes that share a door share one clock.** | Same end, same marks; viz-check enforces it. For 06: 0–1500 ms with the marks `latency` 150 and `budget` 500. Reason: the learner toggles Today ⇄ Goal to compare bars. On one scale, Goal's bar is one tenth of Today's, and that ratio is the lesson. Two scales make the bars look alike. Inside scenes may zoom. The budget mark on Today is not a spoiler: it comes from the committed test and is the line the scaffold crosses. |
| 40 | 06 Goal content | **`add` before `go`; results land when the workers finish.** | (a) `add("waitgroup", 10)` comes before `go("worker[*]")`. That is the correct idiom; `Add` after `go` is the classic WaitGroup bug, and the first draft drew it. (b) The caller does not fill the slice after `Wait`, because nothing then says where the values came from. The results enter the slice in the step the workers finish. Steps: 1. the caller adds 10, starts the workers, and waits (rings: caller, WaitGroup, worker). 2. At 150 ms every call ends, the 10 results enter the slice, and each worker calls `done`, which wakes the caller (rings: thumbnail, WaitGroup, caller). 3. The workers exit, the caller returns at 150 ms, and all three tests pass (rings: worker, caller, tests). |
| 41 | Are Today and Goal enough for 06? | **Yes.** | An inside "close too early" scene may come later if it fits 6 rows. There is never a race-detector fact: a race is not a fixed schedule, and the browser has no detector. |
| 42 | Worker group, compression, and the third test | **Confirmed.** | One counted row labeled "worker" (`count: 10`). `repeat` is the intended compression for a loop. The third test passes on the scaffold, because sequential code shares nothing (`06-fan-out-fan-in/check_test.go:102-145`). Its short name "race-safe" matches its documented purpose. |

**Door and contract**

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 43 | 31 has no Goal scene | **Add one at the README's level.** | Rows: Serve, handler (tier `goal`), ctx, tests. Serve parks receiving on ctx ("← ctx"); handler works "handler()". At 100 ms Done closes, and Serve wakes and returns. The handler keeps running and exits at 500 ms with nobody listening. The deadline test passes. The scene has no result channel and no `select`, because the README draws neither. The inside scenes show them. |
| 44 | Derived text in Problem scenes | **The spoiler rule also scans derived row text.** | Run the fold over every Problem scene and scan each row's rendered text and sentence. For example, "select (2)" fails when the README never says "select". Reason: derived text is still visible text. |
| 45 | A stale pin | **Hide only that tier's scenes.** | When one fence serves both tiers, both are hidden. Solution scenes stay. |
| 46 | A step counter in the door | **Yes.** | At the right of the chip row, as §3.2 shows. It is hidden while the Diagram view shows. |
| 47 | The Diagram chip and arrow keys | **Keep Diagram in the radiogroup, in the order Diagram, Today, Goal. Arrows do not wrap.** | Diagram is one of the views, so one control holds all of them. Without wrap-around, an arrow press at the end of the row cannot close the stage by accident. |
| 48 | Is the skill the only contract? | **Yes. The skill is self-sufficient.** | Inline into SKILL.md and REFERENCE.md every rule an author needs. The review is the rationale record for the reviewer and the kit maintainers. The skill says that an author does not need the review to write a spec. If the skill and the review disagree, the skill has a bug; report it. |
| 49 | CLI flags, `new`, and `spoilerOk` | **One pin interface, and declare every field the checker reads.** | `npm run viz -- pin <id>`: with one diagram fence it writes both pins; with several, it lists them and requires `--today N` and `--goal N` (rename `--goal-fence`). `new` behaves the same way. Declare `spoilerOk?: Record<string, string>` (word → reason) in `VizSpec`. A checker never reads a field the types do not declare. |

### 7.5 Phase 2 review

**Verdict: accepted once decisions 50–55 are fixed.** Phase 3 may start then. The reviewer re-ran the checks: `tsc` is clean, `check-visuals` passes 4 specs with the expected warning that the commit must include `06-fan-out-fan-in/README.md`, 68 of 68 tests pass, and `make lint` is ok. A planted "select" in 31 Goal fails with the solution line it came from. The 06 Goal scene follows decisions 39 and 40: one 0–1500 ms clock, `add` before `go`, results that land when the workers finish, and rings that match each caption. The skill states that an author needs no other document (decision 48).

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 50 | 31 Goal marks the deadline test as passed at 100 ms | **Must fix. Mark a test at the step where the real test can reach its verdict.** | The test sleeps 500 ms and then checks `h.RanToCompletion()` (`31-serve-timeout-race/check_test.go:85-91`), so it cannot pass before the handler finishes. Move `pass("tests.deadline")` to the 500 ms step: "At 500 ms the handler exits with nobody left listening, so the deadline test passes." Apply the same rule to every spec. |
| 51 | The chip bar renders at the bottom of the figure | **The chip bar sits at the top of the door in both views.** | This amends §4.1, which put the bar under the diagram, and confirms zone A in §3.2. The order is: the chip bar (with the step counter at its right in scene view), the transport (scene view only), then the stage or the `<pre>`. Toggling Diagram ⇄ Today ⇄ Goal then never moves a chip, because only the content below the bar changes height. The "▶ Watch" prefix shows only in Diagram view. |
| 52 | The Diagram radio is never checked | **Must fix. Exactly one radio is checked at all times.** | Diagram is checked in Diagram view. A radiogroup with nothing checked breaks the pattern for screen readers. |
| 53 | Is there a per-door chip budget? | **Yes. Each Problem tier has at most one scene.** | A door then holds at most three chips: Diagram, Today, Goal. The Solution block holds at most three inside scenes. viz-check enforces both limits. Three chips plus the counter fit 198 px. |
| 54 | The group row overflows above 10 members and does not line up | **The group row has two lines (44 px) and counts as one row in the row budget.** | Line 1 lines up with the other goroutine rows: the status rail, an aggregate glyph, the name and "×N" in the name column, and at the right one glyph-and-number pair per state that has members ("● 4 ‖ 3 ○ 3"). Line 2 is the disc strip, from the name column to the right edge (181 px): 8 px discs with 3 px gaps up to 16 members, 6 px discs with 2 px gaps from 17 to 22, and no strip above 22. The aggregate glyph is "parked forever" if any member is; else running if any member runs; else parked if any member is parked; else exited if all have exited; else idle. This replaces the widths in decision 38. The 420 px height budget still applies. |
| 55 | May a `spoilerOk` reason be empty? | **No. viz-check rejects an empty or blank reason.** | A reason says why the word is safe in a Problem scene. This is the same standard as the `exceptions` list in `tools/check/lint.go`. |
| 56 | The "▶ Watch" label moves every chip 51 px when the view changes | **Remove the label. Each scene chip carries the play glyph, in both views.** | The chips read "Diagram", "▶ Today", "▶ Goal". The glyph is `glyph("play")` from `kit/glyphs.ts`, the same mark as the transport's Play button. The Diagram chip has no glyph. Each chip keeps its width in both views, so no chip moves. The glyph says "this plays" better than a text label does, and it costs about 24 px instead of about 51 px. The bar must fit 198 px with the step counter; the pixel check enforces it. |

**Phase 2 is accepted** (re-check after decisions 50–55: `tsc` clean, 72 of 72 tests, 4 specs pass with the expected 06 warning, lint ok). The frames show the chip bar on top, a 44 px two-line group row that lines up with the other goroutine rows (06 Goal step 2 at 401 px), and 31 marking its test at 500 ms. Decision 56 is the first change of Phase 3.

### 7.6 Phase 3 decisions

Decision 56 is verified: the chips keep the same position and width in Diagram and scene views (06: Diagram at x = 290, ▶ Today at 349.8, ▶ Goal at 409.1 in both).

| # | Question | Decision | Condition and reason |
| --- | --- | --- | --- |
| 57 | 21 Dining philosophers: five philosophers and five forks need 11 rows | **Linearize the ring the way the README already does: one row per philosopher and no fork rows.** | The README diagram draws the ring as five lines, "P0 holds F0, wants F1 ──▶ held by P1", with the last line closing back to P0. The forks are mutexes declared `inline: true`. An inline mutex gets no row. The kit draws a held inline mutex as a token on its holder's row ("[F0]", at most two per row), and the wanted one through the derived text ("lock F1"). The row reads like the README line: `P0 ‖ lock F1 [F0]`. Rows: P0–P4 plus tests, 6 rows. There is no `ring` kind, because a ring is not a Go object; the deadlock verdict strip names the cycle: "Deadlock: P0 → P1 → P2 → P3 → P4 → P0" (decision 29). **Scenes.** Today: every philosopher takes the left fork, then waits for the right one; Dine never returns, and the timeout fails `TestDineCompletesWithoutDeadlock`; outcome `deadlock`; the caption says the five pickups happen "at roughly the same time", as the README does. **No Goal scene:** the README names no strategy, so any goal picture would reveal one. Inside, "Ordered" (resource ordering): P4 reaches for F0 first, finds it held, and waits holding nothing, so P3 can take F4 and eat, and the chain unwinds; outcome `pass`. The arbitrator approach gets no scene, because it needs a seventh row (the seats); the solution doc covers it. When two philosophers wait for one fork, `unlock(…, { to })` names the next holder, and no caption implies an order: `sync.Mutex` promises none. **Placement:** the door on the README's ring fence, with the chips Diagram and ▶ Today. There is no inline panel; decision 2 makes the door the only home for Problem scenes. |
| 58 | The ring cap when one verb changes many rows | **Rows that change by the same verb in one step count as one ring toward the cap of 3, when the caption names them as one group.** | Example: "Every philosopher picks up the left fork." Five rows ring, the verb is `lock` for all five, and the caption names the group, so the step uses one of its three rings. viz-check counts distinct verbs among the ringed rows; the caption must name the group. Reason: symmetric actors are the point of 21, and the cap exists to keep each change named, not to forbid symmetry. |
| 59 | 13 needs 7 rows; 29 needs 8 or more | **A channel may be `inline: true` when its buffer holds no token in any frame of any scene.** | viz-check proves it by running the fold. It is always true for an unbuffered channel used only for hand-offs and `close`. An inline channel gets no row. Its waits show on the goroutine rows ("send → chanStream", "recv ← shard"). Its close shows as derived text on the woken receivers ("shard closed"). Never inline a channel whose buffer is the lesson, such as 18's `ch`. This extends decision 57 from mutexes to channels. |
| 60 | 27 and 29 need a timer that resets | **Add a runtime kind `timer`.** | Cast: `{ kind: "timer", label, after }`, with `after` sourced as a constant. Verbs: `start(t)`, `reset(t)`, `stop(t)`. When the clock passes the fire time (before the step's ops, like a context deadline), the timer delivers one value on its channel (capacity 1). That value goes to a parked receiver or a select case `onRecv(t)`, or waits until one receives it. `reset` discards a pending value; this is the Go 1.23 behaviour that `solutions/27-heartbeats.md:181-184` relies on. A fresh `time.After` per loop pass is modeled as `reset`. A timer requires a scene clock. Its row shows the label, a countdown bar from `after` to 0, and the text "fires in N ms", "fired", or "stopped". A reset refills the bar and rings the row. This draws the 27 README's diagram ("watcher timer: reset reset … FIRES") literally. |
| 61 | 27's heartbeat has capacity 1 in the scaffold and 0 in the solution | **Two cast entries with the same label.** | One entry has the scaffold's capacity (tier `today`, from `27-heartbeats/main.go` at HEAD). The other has the solution's capacity (tier `inside`, a constant sourced from the solution doc). They never share a scene; viz-check rejects two rows with one label in one scene. A Goal scene uses the scaffold's entry unless the README states the capacity. |
| 62 | A 3-case select changes 4 rows | **Parking rings only the parked goroutine.** | When a goroutine parks on a channel, mutex, wait group, timer, or context, the waited-on row's "waiting" count updates without a ring. The goroutine's own text already says what it waits on ("select (3)"). A waited-on row rings when its own content changes: a token, a close, a fire, or a counter. When a case wins, the goroutine and the winning row ring (decision 19). A 3-case select therefore parks with one ring. |
| 63 | 29's wedge: the README says a wedged ward never exits, but the mock returns | **Follow the mock, because the tests run the mock.** | After its fifth pulse, a generation returns without closing its heartbeat (`29-healing-goroutines/mockward.go` at HEAD). To the steward that is silence, which is all a wedge looks like from outside. Script it as `exit`, and let the caption say the generation "goes silent". Do not use `forever`: it would claim a leaked goroutine in a test that passes under `synctest`. A caption may add: "a real wedged ward might never exit; the steward does not wait either way". **Rows:** caller; steward (tier `goal`); ward ×3 (a group whose members are the generations: exited, running, not started); timer (tier `goal`, `after` = the 350 ms timeout); pulses (cells, 12 slots: the pulses the caller has received, the test's `wantPulses`); tests. That is 6 rows. Each `wardDone`, each ward heartbeat, and the steward's heartbeat are inline. |
| 64 | A failure lands far past the interesting window (29 Today's 5 s test deadline) | **A step may go past `clock.end`.** | The history underline runs to the right edge, a break glyph (`glyph("break")`) sits at the edge, and the readout shows the true time ("t 5 s"). Problem scenes still share one clock (decision 39), so Goal keeps its detail. It applies only to 29 (21 and 04 have no clock; decisions 67 and 75). **13's shape**, using decisions 59 and 62: rows LogHub, shard ×5 (a group: the producer goroutines), Bridge, fwd ×5 (tier `goal`), main, tests. `chanStream`, each shard's lines, and `out` are inline. `main` is a cells row with 20 slots fed by `push`: main ranges over `out` and never makes Bridge wait in these scenes, and the count of lines it got ("4 of 20") is the lesson. Today: LogHub parks forever sending shard 1 on `chanStream`, `shard[1]` parks forever sending its first line, `shard[2..4]` never start, and main gets 4 of 20. Outcome `leak`; the strip names LogHub and `shard[1]`, and the tests row shows `TestBridgeFlattensAllShards` failing. |
| 65 | Three chips plus the step counter need 208 px; the bar has 198 | **Move the step counter to the footer row. The chip bar holds only chips.** | The footer reads "▸ One possible schedule" at the left and "2 / 3" at the right. The chips keep their padding, with 4 px gaps; the bar then needs about 173 px. Do not shrink chip padding to fit; that makes cramped touch targets. Reason: the counter counts steps, and the footer's summary opens the list of those steps, so the two belong together. The counter still hides while the Diagram view shows, because the footer is part of the scene view. This amends zone A in §3.2 and decision 46. |
| 66 | Scene chips are 26 px tall, against the 32 px control rule | **Every control in the figure is at least 32 px tall and 32 px wide.** | That covers the chips, the transport buttons, and the footer's summary row. They are tap targets on a 320 px phone. The figure grows by about 20 px (the tallest frame is 359 px today), still under 420. Zone A in §3.2 becomes 32 px. The pixel check enforces the rule for every interactive element in the figure. |
| 67 | 21 Today's clock | **21 has no clock. Give a scene a clock only when a duration or a deadline is part of its lesson.** | 21's lesson is a ring of waits, not a duration. The test's 3 s timeout only ends the scene, so it goes in the final caption as a constant (`21-dining-philosophers/check_test.go:72`), and that step marks the test failed. Decision 64's mention of 21 is withdrawn; decision 64 still applies to 04 and 29. The written spec builds the ring one link per step, mirroring the README diagram line by line, and closes it in the last link. Keep that structure. Merge its first two steps into one: "Dine starts all five philosophers, and P0 takes its left fork F0." (the five `go` ops count as one ring, decision 58). That leaves 7 steps. |
| 68 | Timer details chosen by the kit | **Accept the state rules, with three changes.** | Accepted: `reset` arms or re-arms from any state and discards a pending value; an idle timer reads "not started". Changed: (a) The delivered token shows `glyph("timer")`, not the text "fire". Tokens hold at most 3 characters, and no scene reads a timer's value; what matters is that it fired. The row's sentence says "a timer tick". (b) `start` on a timer that is not idle is an error that says "use reset". `stop` is legal on a running timer, and on a fired timer with a pending value (it discards the value, as in Go 1.23). `stop` on an idle or stopped timer is an error that says "nothing to stop", because it points to a script mistake. (c) Layout: the name starts in the shared name column, the same x as goroutine names, not at a separate 4 px indent. Then comes a countdown bar of at least 56 px, then the remaining time only ("250 ms"), or "fired", "stopped", or "not started". The bar is the lesson of 27, so it must be readable. **All non-goroutine rows** start their name in that shared name column, so every row name shares one left edge. |
| 69 | A receive from a closed channel | **The receiver shows "<channel> closed" and holds no token.** | This applies to every channel, inline or not. Go does return the zero value, but a drawn "0" reads as a real item: in 18, item 0. The row's sentence says "receives the zero value because shard is closed". If a future lesson is "the zero value looks like data", the reviewer decides that scene then. |
| 70 | Clock mark labels overflow at the right edge (08, 22, 28) | **Marks lie strictly inside the axis, and labels near an edge align to that edge.** | viz-check rejects a mark at or beyond `clock.end`. The three failures put a mark exactly at the end (200/200, 2000/2010, 300/300), where its label collides with the end label. Set `end` past the last mark; the window should show a little time after the event anyway. In the kit, a mark label within half its width of either edge aligns to that edge instead of centering on its line. |
| 71 | 21's deadlock strip prints "p0 → p1 → … → p0" | **Must fix in the kit. Derived text always uses row labels, never cast ids.** | This covers the verdict strip, row text, sentences, and the transcript. The strip reads "Deadlock: P0 → P1 → P2 → P3 → P4 → P0". |
| 72 | 27's heartbeat token shows "pu…" | **Must fix. A value-less send shows a glyph, and viz-check limits token text to 3 characters.** | A `struct{}{}` send has no value to print. `ops.ts` exports `SIGNAL`; a token with that value renders as `glyph("signal")`, and its sentence says "a signal". This mirrors the timer's token (decision 68). viz-check statically rejects any token value in `send`, `signal`, `push`, or `put` that is longer than 3 characters and is not `SIGNAL`. The shots check missed "pulse", because the token clips its text; the static check catches it before render. |
| 73 | Review of the 21 spec | **Accepted once three changes land.** | The Today frame shows the ring at a glance: five rows parked forever, each holding one fork and waiting for the next. (a) Decision 71 fixes the strip. (b) Order's last step must exit all five philosophers: the test passes only when `Dine` returns after every meal (decision 50). The caption becomes "Every philosopher eats this way until all meals are done; Dine returns, and the deadlock test passes." (c) Merge Order's first two steps into one, so the caption matches the ops: "Dine starts all five, and each locks its lower-numbered fork first: P0 takes F0." The original first caption described locks that its step did not run. |
| 74 | Review of the 27 spec | **Accepted once decision 72 lands; the two design notes are accepted.** | The facts match HEAD: a 1500 ms flat timer (300 × 5), results at 400 and 800 ms (`UnitDuration`), and no pulses on the stall path (`mockworker.go`). Goal fires at 1100 ms, 300 ms after the last result. The healthy-flat scene belongs in the Solution tab: it shows why the fix must reset the timer rather than shorten it. Two timer rows, `flat` and `timer`, are right: each is a ghost in the other scene, so the comparison shows the swap. One heartbeat row with capacity 1 is right: no scene models the solution's code at that level. **Clarifies decision 61:** a scene uses the capacity of the code it models; a second entry is needed only when some scene models the solution's code. |
| 75 | 04 Trap's 5 s wait | **04 has no clock (decision 67).** | 04's lesson is that `main` is stuck inside `Stop()` while the second signal sits unread. The 5 s wait only ends the scene, so it goes in the final caption as a constant (`04-graceful-sigint/check_test.go:167`), and that step marks the test failed. Decision 64 now applies only to 29. |
| 76 | Review of the 08 spec | **Accepted once one caption fix lands.** | The facts match HEAD: 20 items at 10 ms per stage (`WorkLatency`) take 400 ms in the scaffold, against the 250 ms overlap budget. The Goal finishes at 220 ms with four overlapping stages. The inside scenes follow Go's semantics. Fix: in the scaffold, `Pipeline` calls `keepEven(square(generator(…)))` inline on its own goroutine (`08-pipeline/main.go` at HEAD), so "Pipeline waits while square squares" is false. Pipeline does the squaring. Today step 2 becomes "Pipeline runs square over all 20 numbers: 200 ms in all." Step 3 becomes "Pipeline runs keepEven over all 20 next, reaching 400 ms." |
| 77 | Review of the 22 spec | **Goal must be reworked.** | Today and the inside scenes match HEAD: the scaffold's `Execute` passes every call to `gateway.Charge`, and holding `mu` across `Charge` serializes calls. But Goal leaves `caller` as "not started" and `calls` as "not used" while its captions talk about calls. Rework Goal: the caller makes every call. `calls` counts the calls that reach the gateway: the 5 failures reach it; while OPEN the next call fails fast and `calls` stays at 5; after the cooldown, the trial reaches it (6) and succeeds. `failures` (limit 5, the threshold) counts consecutive failures. Rows: caller, calls, failures, breaker, tests, so 5 rows. Remove `limit` from `calls` (decision 78): the trial is a legitimate sixth call. Toggling then shows the lesson: Today's sixth call reaches the gateway; Goal's sixth call does not. |
| 78 | Two checks the 22 review shows are missing | **viz-check: a caption may not name a ghost row, and a pass scene may not end with a meter past its limit.** | (a) A ghost row says "this is gone in this scene". When a step's caption contains the label of a row that is a ghost in that frame, the scene contradicts itself, so it is an error. The message names the row. (b) A meter's `limit` means "past this is wrong in every scene of the spec". If a `pass` scene ends with a meter past its limit, the scene or the limit is wrong, so it is an error. If a value may legitimately pass the number in some scene, the meter has no limit. |
| 79 | 28 mixes the demo's run with a test's run | **A scene models one run: `main()` or one named test. Its numbers and names come from that run's source.** | 28 Today uses `main()`'s three replicas (A 150 ms, B 10 ms, C 300 ms), but its captions quote the fastest test's setup: "the test sleeps 5 ms", "both losers". That test has four replicas (`fast` 10 ms; `slow1`–`slow3` at 100, 200, 300 ms). The blend is a run that never happens. When the README diagram draws `main()`'s run, as 28's does, Problem scenes use `main()`'s numbers and the README's names. A tests row may still mark a test whose assertion is a property of any run of that shape. The caption then names the property, not the test's private setup. viz-check cannot check this, so it goes in the skill, and the reviewer checks it. |
| 80 | 28's late result shows the token `0` | **A token shows the value as Go source would write it, in at most 3 characters.** | Write `""` for an empty string, `nil` for nil, and a number only for a number. A cancelled replica returns `("", nil)` (`28-replicated-requests/mockreplica.go` at HEAD), so its late result shows `""`, never `0`. This is a send of a real value, so decision 69 (no token on a receive from a closed channel) does not apply. |
| 81 | Review of the 28 spec | **Accepted once four changes land.** | (a) Today and Goal captions name the property, per decision 79. For example: "Shortly after replica-B wins, replica-A and replica-C are still running; the fastest test requires every loser to stop, so it fails." Drop "both losers" and "the test sleeps 5 ms". (b) Late-result tokens are `""` (decision 80). (c) The winner scene starts all three replicas, so `res`'s capacity of 3 equals `len(replicas)`. Then show both losers' late results landing in the buffer without blocking, which is that scene's lesson. It marks no test, so it has no tests row and fits 6 rows (caller, A, B, C, stop, res). (d) The leak scene must show the winner: replica-B sends first on the unbuffered `ch` and the caller receives it; the caller closes `stop`; replica-A wakes and its send of `""` on `ch` parks forever. Rows: caller, A, B, stop, ch. The cancel scene is right: its test uses exactly two replicas, with `done` closed up front. **Clarifies decision 24 and the outcome rules:** an inside scene may mark no test. It then has no tests row, and `pass` requires only that no goroutine is parked. |
| 82 | 22 Goal now shows `caller` and `calls`, which its pinned fence does not draw | **22 is accepted. The vocabulary is the whole README; a fence decides placement, not words.** | The reworked Goal matches decision 77: the caller makes every call; `calls` holds at 5 while OPEN and reaches 6 only with the trial; `failures` resets; the breaker returns to CLOSED; the recovery test passes. `caller`, `Execute`, and `gateway.Charge` appear in the README's other fence, so decision 23 allows them. A scene may show any row the README names; its pinned fence decides only where it mounts. Row identity (decision 31) also requires the caller in Goal, because the same goroutine acts in both Problem scenes. No skill change follows from 22 beyond decision 78. |
| 83 | Review of the revised 28 | **28 is accepted. The step counter appears only in the footer, in every chip bar.** | The winner frame shows the two losers' `""` results in `res` with one slot still free, so no loser blocks. The leak frame shows the winner, then replica-A parked forever sending `""` on the unbuffered `ch`, with the verdict "Leak: replica-A parked forever on ch". One kit fault: the Solution block shows "7 / 7" both in its chip bar and in its footer. Decision 65 applies to every chip bar, the door's and the Solution block's, so remove the counter from the Solution block's bar. |
| 84 | 13 put Bridge first because the kit's `callerOf` treats the first goroutine as the leak's caller | **Remove `callerOf`. Define leak and deadlock by what the final world shows. Cast order stays data-flow order.** | **Leak:** at the end, at least one goroutine is parked and at least one goroutine has exited (the code that returned). **Deadlock:** at the end, every started goroutine is parked and none has exited (the code under test is itself stuck). The two never overlap. A kit detail must never decide a design rule such as row order (§2.5). 13's order is LogHub, shard ×5, Bridge, fwd ×5, main, tests. |
| 85 | Derived text such as "send 1 → chanStream" is too long | **Derived send text is "→ <channel>" and receive text is "← <channel>". The value shows only as the held token.** | The token already sits beside the text, so repeating the value only costs width. Labels stay the code's own identifiers: 13's channel is `chanStream` again, the README's and the signature's name, and "→ chanStream" is 12 characters. The same rule shortens 18's "send 3 → ch" to "→ ch" with the token `[3]`. "select (2)" and the woken "← sigChan" stay as they are. |
| 86 | 13's strip says "shard parked forever", not "shard-1" | **A group member is named "<label>-<i>" in all derived text, counting from 0.** | This is how the README writes them: "shard-0", "shard-1..4", "fwd-0". The strip names a single member ("shard-1"), and collapses only two or more members that wait on one target (decision 30). An inline channel group follows the same rule ("lines-1"). |
| 87 | The strip text when several goroutines leak | **One goroutine: "Leak: replica-A parked forever on ch". Two or more: "Leak, parked forever: LogHub → chanStream, shard-1 → lines-1".** | The longer form uses the row arrows (→ send, ← receive), names at most two goroutines, then adds "+N more", and wraps to at most two lines. 13 Today reads "Leak, parked forever: LogHub → chanStream, shard-1 → lines-1". |
| 88 | Review of the 13 spec | **Accepted once decisions 84–87 land, plus three spec fixes.** | The story matches HEAD: LogHub parks sending shard 1 on the unbuffered `chanStream`; `shard-1` parks on its first line; `shard-2` to `shard-4` never start; main holds 4 of 20 lines; in Goal all 20 arrive and everything exits. No clock is right (decision 67). Spec fixes: (a) the end captions read "…so the flatten test fails." and "…so the flatten test passes." instead of "the flatten test result is fail/pass"; (b) `chanStream` tokens are "s0" to "s4", because each is a shard's channel, not a line; (c) a scene without a clock has no step `t`: viz-check rejects `t` in a scene with no clock, so no timing hides in data the stage never draws. Captions may still state the cadence ("every 5 ms") from constants. |
| 89 | 13's five `lines` channels share one label, so the strip says "shard-1 → lines" | **Labels are unique within a spec.** | The only exception is decision 61's capacity pair, which never shares a scene. When several channels share a role, label them like group members: "lines-0" to "lines-4". Derived text then tells them apart: "shard-1 → lines-1". viz-check enforces unique labels. |
| 90 | The 29 README numbers generations from 1 ("gen 1", "gen 2") | **A group's member numbers follow the README.** | Count from 0 like Go indexes ("shard-0"), unless the README numbers the members from 1. Then declare `base: 1` on the group. This amends decision 86. 29's ward group uses `base: 1`: ward-1 to ward-3, and with them wardDone-1 to wardDone-3 and heartbeat-1 to heartbeat-3 (decision 89). |
| 91 | 29 marks `pulse` at 100 ms and `timeout` at 350 ms | **A clock mark is an instant in the run. A duration is never a mark.** | The timeout counts from the last pulse, so a mark at 350 ms says something happens at 350 ms, and nothing does. A duration (a timeout, an interval) belongs to a timer row or a caption. 29's marks are `silent` at 500 ms and `restart` at 850 ms. Both are shared by Today and Goal: Today shows nothing restarting at 850 ms, and that is the comparison. |
| 92 | When may a test be marked? | **Decision 50, clarified: never before the real test can reach its verdict. Later is allowed.** | So one final step may mark two tests whose verdicts came at different times. |
| 93 | 13 after decision 88 | **13 is accepted once decision 89 lands.** | The Today frame now reads in data-flow order: LogHub parked on "→ chanStream" holding `s1`, the shard group with one parked, one exited and three never started, Bridge exited, and main at 4 of 20. With unique labels, the strip reads "Leak, parked forever: LogHub → chanStream, shard-1 → lines-1". |
| 94 | Review of the 29 spec | **Accepted once five fixes land.** | Today matches HEAD: one generation, five pulses, silence, and the 5 s deadline past `clock.end` with the break glyph. Fixes: (a) **Arithmetic.** Generation 2 starts at 850 ms and pulses five times, at 950 to 1350 ms. The spec has it go silent three intervals in (`midMs = restartMs + 3 × pulse`), which moves every later time. The correct times: silent at `restartMs + pulsesBeforeWedge × pulse` (1350 ms), second restart at 1700 ms, pulses 11 and 12 at 1800 and 1900 ms. Captions follow; `clock.end` is 2000. (b) **Marks:** decision 91. (c) **Tests.** Goal is the restart test's run (12 pulses). That test's last assertion comes after done closes and a 5 × timeout wait, so its verdict lands at 3650 ms, past the end, with the break glyph (decision 64). Goal's 8 steps: 1. start (0); 2. first pulses (200); 3. pulses 3–5, then ward-1 goes silent (500); 4. the timer fires; the steward closes wardDone-1 and starts ward-2 (850); 5. ward-2 pulses five more times and goes silent, and at 1700 ms the timer starts ward-3 (one step: generation 2 repeats generation 1's pattern); 6. pulses 11 and 12, and the caller closes done (1900); 7. the steward stops its timer, closes wardDone-3 and exits, and ward-3 exits (1900); 8. no generation starts after done, so the restart and fresh-done tests pass (3650). (d) **The timer** is stopped in step 7. A countdown that still runs after its owner has exited invites the false question "will it fire?". (e) **Numbering:** decisions 89 and 90. |
| 95 | The vocabulary rule rejects "lines-0" to "lines-4", because the README has no "lines-" | **The checker accepts a README word plus an index suffix. Never edit a README to satisfy a checker.** | A flow label passes when it equals a README word, or when it has the form `<README word>-<n>`, where n is a whole number. This is the member naming of decisions 86 and 90, which the README itself uses ("shard-0", "fwd-0"). The README is the teaching source the checks serve. A README change made only to pass a check reverses that, and it would also need the owner's commit. |
| 96 | 29 step 5 at 1700 ms shows 5 pulses, though 10 had arrived by 1350 ms | **A row rings only when what it draws changes. A frame at time t shows every event before t.** | **Rings:** a ring follows rendered change (text, glyph, token, bar, discs, counts), not internal state. A select whose cases change while its text stays "select (3)" does not ring. The kit's change test must compare what the row draws. **Time order:** the step 5 caption says "ward-2 sends pulses 6 to 10", but the pulses row still shows 5, and the steward holds a pulse it never forwarded while the caller waits. A frame may not show less than had happened by its time, and its caption and stage must agree. The reviewer checks both, because no check can. With the ring fix, step 5 rings ward, timer, and pulses, and generation 2's pulses 6–10 move into it. After the step, the steward holds no unforwarded pulse. |
| 97 | The rest of the 29 review | **Accepted once decision 96 lands and two spec fixes are made.** | "pulse-1" to "pulse-3" for the generation heartbeats is accepted. They are inline, so they have no row, and the 10-character name limit does not apply. They are a README word plus an index (decision 95), and they read clearly beside the steward's own "heartbeat". Fixes: (a) step 8 marks both the restart and the fresh-done tests (decision 94 (c)); (b) captions keep a label's case: write "ward-2", never "Ward-2", and start the sentence another way, for example "At 1700 ms ward-2 …". |
| 98 | 13 after decision 95 | **13 is accepted.** | The Today frame reads in data-flow order, and the strip reads "Leak, parked forever: LogHub → chanStream, shard-1 → lines-1". |
| 99 | When the caller receives a pulse, the caller row and the pulses row both change, and the cap counts them as two rings | **A fact op may name the goroutine whose action it records: `push(id, v, { by: g })`.** | The same option works on `put`, `set`, and `add`. When g also changes in that step, the fact row's ring counts with g's ring toward the cap. The caption names the event ("the caller receives pulses 11 and 12"). The option also documents cause for readers. viz-check rejects a `by` that names a goroutine that did not change in the step. |
| 100 | 29 pushed pulses into the wrong steps to stay under the ring cap | **Truth outranks every budget.** | When a budget (rings, steps, rows) forces a frame to show an event before or after its time, stop and raise it with the reviewer. Never distort the model to fit. The 29 draft did this three times: step 4 (850 ms) forwards ward-2's first pulse, which comes at 950 ms; step 6 (1700 ms) adds pulse 11, which comes at 1800 ms; step 8 (3650 ms) adds pulse 12, which arrived at 1900 ms. Put this rule in the skill, next to decision 96. |
| 101 | The 29 Goal plan with decision 99 | **Eight steps, each true to its time.** | 1. Start: steward, ward-1, the timer (0). 2. Pulses 1–2 reach the caller, `by: "caller"`; the timer resets (200). 3. Pulses 3–5; ward-1 goes silent (500). 4. The timer fires; the steward closes wardDone-1 and starts ward-2; no pulse yet (850). 5. Ward-2's pulses 6–10, from 950 ms; ward-2 goes silent (1350). 6. At 1700 ms the timer starts ward-3; pulses 11 and 12 arrive at 1800 and 1900 ms; the caller closes done (t 1900). Generation 3's restart repeats generation 2's, so it shares a step. 7. The steward stops its timer, closes wardDone-3, and exits; ward-3 exits (1900). 8. No generation starts after done, so the restart and fresh-done tests pass (3650). Rings: at most 3 per step, with every push attributed to the caller (decision 99). The steward's unchanged "select (3)" does not ring (decision 96). The renumbered steps 5 and 6 from the latest draft are accepted. |
| 102 | 29 step 4 shows the caller "running" holding pulse 5 at 850 ms, and the steward "running" with no work | **A row shows the goroutine's state at the frame's time. Between events, a goroutine is parked on what it waits for.** | At 850 ms the caller has waited 350 ms since pulse 5, so it is parked on "← heartbeat". After restarting a ward, the steward parks again in "select (3)", its resting state. "Running" with no work text claims the goroutine is busy, so the frame must show it doing work at that time. Script each step to end with the goroutine's real state at the step's time. In 29, the steward ends every step from 1 to 6 parked in "select (3)". Its row then reads the same as before and does not ring (decision 96). The caller is running only at steps where a pulse arrives at that step's time (200, 500, 1350, 1900). This extends decision 96's time-order rule from events to states; the reviewer checks it. |
| 103 | 29 step 6's caption must name 1700 and 1800 ms, but the caption-number rule allows only the frame's own time | **A caption may name any clock time in its step's span: after the previous step's time, up to its own.** | Step 6 runs from after 1350 ms up to 1900 ms, so "At 1700 ms the timer starts ward-3; pulses 11 and 12 arrive at 1800 and 1900 ms, and the caller closes done" passes. A time outside the span is still an error. |
| 104 | The last 29 review | **29 is accepted once three fixes land.** | Decision 101's structure is right: every pulse lands in the step that covers its time, and step 7 shows a clean shutdown. Fixes: (a) a pulse is `struct{}{}`, so every pulse token is `SIGNAL` (decisions 72 and 80); the caller held "5" and "12", but the count lives in the pulses row; (b) states per decision 102; (c) the step 6 caption becomes the sentence in decision 103, because ward-3 starts at 1700 ms, not 1900 ms. |
| 105 | 29 step 6 needs 4 rings once the steward's real state shows | **Merge pulses 1–5 into one step and give the second restart its own step. No budget exception.** | At 1900 ms the caller closes done, so the steward's select wakes on its done case: a real, visible change. Step 6 then rings caller (with pulses), ward, timer, and steward. The final Goal, 8 steps: 1. start (0); 2. pulses 1–5 reach the caller, each resetting the timer, and ward-1 goes silent (500); 3. the timer fires; the steward closes wardDone-1 and starts ward-2 (850); 4. ward-2's pulses 6–10, and ward-2 goes silent (1350); 5. the timer fires; the steward closes wardDone-2 and starts ward-3, and the caller is parked (1700); 6. pulses 11 and 12 arrive at 1800 and 1900 ms, the caller closes done, and the steward wakes on done (1900); 7. the steward stops its timer, closes wardDone-3, and exits, and ward-3 exits (1900); 8. no generation starts after done, so the restart and fresh-done tests pass (3650). Merging pulses 1–5 loses little: the timer bar is still full at 500 ms, so the frame shows that the pulses reset it, and the caption says so. The second restart gains its own step, which is better than sharing one. A budget exception is for when no true layout exists; here one does. This supersedes the step list in decision 101. |
| 106 | 29 step 6 shows the timer at 150 ms, and the caller's change draws no ring | **Two last fixes: every forwarded pulse resets the timer, and `by` groups rings for the count only.** | (a) **Spec.** Step 6 forwards pulses 11 and 12 without `reset("timer")`, so at 1900 ms the bar shows 150 ms left, counted from the 1700 ms restart. The steward resets its timer on every pulse it forwards; that is 29's lesson. Add `reset("timer")` after each forward. At 1900 ms the bar is then full (350 ms) and reads the same as at step 5, so it does not ring. (b) **Kit.** The caller changes from parked on "← heartbeat" (step 5) to running with a pulse (step 6), yet only the pulses row draws a ring. Decision 99 groups a `by` fact with its goroutine when counting toward the cap of 3. It never hides a ring: every row whose drawing changed still draws one. Add a kit test. With both fixes, step 6 rings caller with pulses, and steward, so 2 toward the cap. **29 is accepted once these land.** Steps 2 and 5 match decision 105: the caller and the steward rest on their waits, every pulse is `SIGNAL`, and the captions stay within their step's span. |

### 7.7 Phase 3 review — closed

**Verdict: Phase 3 is done.** On 2026-11-05 the reviewer re-ran every check in this checkout: `tsc` clean, `check-visuals` passes 11 specs (4 warnings: the 06, 08, 13, and 29 READMEs are not committed), 133 of 133 kit tests, and `make lint` ok. The implementer's full 216 px run has 38 frames and 0 failures. HEAD is still `ce56fdc`: nothing was committed or pushed.

| Item from §6 | State | Evidence |
| --- | --- | --- |
| `npm run viz -- shots` | Done | 38 frames at 216 px, 0 failures; it caught the clock-label, token, and counter faults (decisions 70, 72, 83) |
| "See why ▸" and "Watch it instead ▸" (decision 5) | Done, and within scope | `web/src/console.ts` only reads the existing `--- FAIL: <name>` lines. The link appears only when a spec's tests row names that exact test and the spec has a Today scene. It opens the door on Today, step 1. "Watch it instead ▸" sits beside 04's "cannot run in a browser" note. Both are real anchors. `web/src/runner/` has no diff. |
| Kinds for Tier B | Done | Inline mutexes and channels (57, 59), `timer` (60), `machine`, two-line group rows (54) |
| Tier B specs | All accepted | 06, 08, 13, 21, 22, 27, 28, 29, plus the pilots 04, 18, 31 |

**What the reviews taught, as rules now in the kit and the skill.** Most defects passed every automated check and were caught only by reading the spec against HEAD: an invented goroutine (31), a classic bug drawn as the goal (40), two programs blended into one run (79), a frame earlier or later than its events (96, 100, 102), and arithmetic that drifted from the mock (94). Keep the reviewer's last step: read each new spec against the committed code, not only its checks.

**Still open, for the owner only.**

1. Commit the 06, 08, 13, and 29 READMEs together with their specs. Until then those four doors work locally and not on the deployed site. The scoped commit rule (decision 34) and `viz-diagram` refuse a spec whose README is left behind.
2. Commit the visualiser itself: the kit, player, stage, specs, checks, skill, and these docs. All of it is uncommitted in this checkout. Never commit a solved `main.go` (AGENTS.md).

Tier C and Tier D exercises stay out of scope until the owner asks for them (§6, Phase 3 cut list).

---

## Appendix — facts to fix during the pilot migration

| Spec | Problem | Artifact |
| --- | --- | --- |
| 04 Fixed | Starts the Stop goroutine at t = 0; the solution starts it after the first signal. | `04-graceful-sigint.ts:169-176`; `solutions/04-graceful-sigint.md:82`, `:89` |
| 04 Trap, Fixed | "waiting for a signal" folds to *running*. | `04-graceful-sigint.ts:116`, `:174`; `fold.ts:124-127` |
| 04 | One `process` board mixes two unrelated state sets (alive/dead and shown/hidden). A typo renders silently. | `04-graceful-sigint.ts:7-20`; `GaugeView.tsx:34` |
| 18 Today | 41 steps on an "event order" axis; the pile in memory appears only as a counter. | `18-bounded-pipeline-backpressure.ts:119`; `VizPlayer.tsx:37` |
| 18 Fix | The hand-off step shows identical cells before and after. | `18-bounded-pipeline-backpressure.ts:176-187` |
| 31 Today | Two steps change nothing but the caption. | `31-serve-timeout-race.ts:22-31` |
| 31 Deadline wins | The deadline rule is red and the `ctx.Done` marker is green at the same instant. | `31-serve-timeout-race.ts:114`, `:136` |
| 31 Handler wins | The caption names a 2 s deadline that the 600 ms axis cannot show. | `31-serve-timeout-race.ts:58`, `:87` |
