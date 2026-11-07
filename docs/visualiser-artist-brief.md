# Visualiser engine review — brief for the visualiser artist

> **Superseded on 2026-11-07.** The visualiser was rebuilt as a scheduler and a graph view. The current design and its decisions are in `docs/visualiser-design.md`; the authoring contract is `.claude/skills/new-visualisation/`. This file is kept as history.

**Role.** You are the design architect for this visualiser. Focus on architecture, UX, visual language, and the authoring contract. Do not spend your time writing every spec or polishing code; the main agent and its subagents will do that labor. Make the hard design decisions once, so a later agent with little context can add a visualisation beautifully and safely without you.

**Repository:** `/Users/loi.nguyenhuynh/Desktop/Personal/go-concurrency-exercises`.
**Deliverable:** write your review and architecture to `docs/visualiser-artist-review.md`. Reply with a short summary: the top five findings, the target shape, and the decisions only the owner can make.

---

## What exists now

The web app is a static Vite + React 19 + TypeScript site under `web/`. It runs the Go toolchain as WebAssembly. The visualiser is new.

| Piece | File |
| --- | --- |
| Types: `VizSpec`, `Scene`, `Step`, `VizEvent`, layouts | `web/src/viz/spec.ts` |
| Pure fold from steps to a frame | `web/src/viz/fold.ts` |
| Player shell: transport, scene select, caption, transcript | `web/src/viz/VizPlayer.tsx` |
| Lane timeline renderer | `web/src/viz/views/LaneView.tsx` |
| Board / gauge renderer | `web/src/viz/views/GaugeView.tsx` |
| Lazy registry | `web/src/viz/registry.ts` |
| Mounting in the doc pane | `web/src/components/VizPanel.tsx`, `DocPane.tsx` |
| Pilot specs | `web/src/viz/specs/04-graceful-sigint.ts`, `18-bounded-pipeline-backpressure.ts`, `31-serve-timeout-race.ts` |
| Checks | `web/scripts/viz-check.ts`, `web/scripts/viz-fold.test.ts` |
| Styles | the `visualisations` block in `web/src/styles.css` |
| Research and full catalogue | `docs/visualisation-handoff.md`, `docs/visualisation-catalog.md` |

**Current placement.** The visualisation is inline, not a third tab. The Problem tab gets a collapsed "See it happen" panel with symptom scenes. The Solution tab gets fix scenes after the existing spoiler reveal. This was chosen because the tab row overflows at the 260 px pane floor and a tab with fix scenes needs the reveal gate lifted.

**Current scenes.** 04 shows the scaffold symptom, the trap, and the fixed two-signal path. 18 shows the scaffold burst and the cap-2 gauge. 31 shows the scaffold, the handler win, the deadline win, and the unbuffered leak.

**Known UX problem.** The first 04 version was a single bar on an "event order" axis. The owner found it confusing. It is now a state board: goroutine chips, a process lamp and stop line, a SIGINT mailbox, and test results. Use that board as a starting point for your critique, not as the final answer.

---

## What the owner wants

- Intuitive first. A learner should understand the pattern in one glance, without reading a paragraph.
- Beautiful and expressive. The visual language should feel designed for Go concurrency, not like a generic dashboard.
- Well designed and extendable. New exercises should not require touching the player.
- The right place at the right time. The visual should appear when the learner needs it, not as decoration.
- Best UX: discoverable, keyboard usable, reduced-motion safe, readable at 216 px of content, good in light and dark.
- After this review, a **dumb agent** with little context must be able to add a visualisation beautifully and elegantly by following the repo's own contract, without asking you.

---

## What to decide

1. **Placement and timing.** Inline in Problem and Solution, a third tab, or another shape? Where should the symptom, the mechanism, and the fix appear? How should a learner discover the visual without spoiling the answer? What happens on a narrow phone and at the 260 px splitter floor?
2. **The visual language.** Define the look: layout grid, type scale, color roles, line and arrow style, channel and goroutine notation, state vocabulary, motion rules, density. Show one canonical example. The current CSS uses the site tokens (`--accent`, `--pass`, `--fail`, `--bg-sunken`, `--border`) and a 30 px lane track.
3. **The authoring contract for a dumb agent.** What does a new visualisation consist of? A spec file? A scene recipe? What is the smallest correct spec? What is the template? What checks make a wrong spec fail before review? What can the agent copy from an existing example? What must it never do?
4. **Renderer families.** Are lanes and boards enough? What are the reusable primitives (clock, span, block state, handoff, slot, waiter, state machine, heap)? How should a new family be added without editing the player? What is the versioning story if the schema changes?
5. **The spec-to-README link.** The clone/GitHub mode carries an ASCII diagram; the web mode carries the spec. How do we keep the two from drifting? Today the lint enforces the ASCII diagram, `viz-check` checks anchors, and the pre-commit gate refuses an exercise README with unstaged changes. Is that enough, or should one artifact derive from the other?
6. **Quality gates.** What should `npm run check-visuals`, the fold tests, and a new visual review check assert? What makes a spec "beautiful" enough to merge, and how much of that can be machine-checked?
7. **The dumb-agent test.** Write a short walkthrough: "A new agent opens exercise 06, sees the README diagram, creates a spec, runs the checks, and gets a good result." Name every file it touches, every decision it makes, and every guard that catches a mistake.

---

## Constraints

- Static site. No new npm dependency unless there is a strong reason.
- 216 px of content at the 260 px pane floor; 288 px on a 320 px phone. One column. No horizontal page scroll.
- Light and dark themes through the existing CSS variables.
- Keyboard first; no hover-only state. `prefers-reduced-motion` starts paused and disables transitions.
- The site reads `.go` files from `git HEAD` and `.md` docs from the working tree. Never publish the owner's uncommitted solved `main.go` files; README edits may be live.
- The browser runs `GOMAXPROCS=1` with no race detector. A scene is a model, not a trace of the learner's code.
- Exercise folders hold only `README.md` and `.go` files. Do not put assets there.
- The pre-commit gate refuses an exercise README with unstaged changes; `viz-check` refuses a spec whose HEAD README has no plain-fence diagram.
- Do not edit `main.go`, `check_test.go`, or the exercise mocks. The owner has uncommitted solutions in the working tree.

---

## What not to do

- Do not write all 43 specs. Pick one or two canonical examples.
- Do not rewrite the player or the CSS in this review. Describe the target; we will implement.
- Do not add a dependency, a chart library, or an animation framework.
- Do not weaken the spoiler gate or the HEAD-only data rule.
- Do not commit anything.

---

## Format of your review

1. **Verdict.** What works, what does not, and the one change with the highest leverage.
2. **Target architecture.** A diagram and a file map. The authoring contract. The renderer families. The validation path.
3. **Visual language.** One canonical scene described in enough detail that an implementer can build it. Include the 216 px case.
4. **Placement and UX.** A table of where each kind of scene appears and when.
5. **The dumb-agent walkthrough.** The exact steps, files, and checks.
6. **Prioritized plan.** Three phases, each with acceptance criteria and what to cut.
7. **Open decisions for the owner.** Only the choices that need a human.
