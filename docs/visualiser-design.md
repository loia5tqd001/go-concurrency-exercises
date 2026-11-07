# Visualiser design

**Status:** current. Rebuilt on 2026-11-07.
**Supersedes:** `docs/visualiser-artist-review.md` and its 106 decisions, the
artist brief, the engine audit, the catalog, and the handoff. Those stay as
history.
**Contract for authors:** `.claude/skills/new-visualisation/` (SKILL.md and
REFERENCE.md). This file records why the engine is shaped the way it is.

## 1. Why it was rebuilt

The first engine drew each scene as a list of rows ("caller", "worker ×10",
"WaitGroup not used", a strip of ticks) and asked the author to write every
step by hand. The owner found it cryptic: "if it's too cryptic then let's
just read the text". A review against a reference page that draws the same
patterns as a live graph found five root causes.

| # | Cause | Evidence in the old engine |
| --- | --- | --- |
| 1 | The design banned the pattern's shape: "The stage draws no free arrows." Fan-out, fan-in, pipeline, and tee *are* shapes. | Artist review §3.3 |
| 2 | The author was the scheduler. Each step listed who does what, so every time and order was placed by hand. Most later fixes (decisions 94, 96, 100, 102, 105, 106) corrected frames that showed the wrong state for their time. | `kit/run.ts` `sendFrom`, the step lists in every spec |
| 3 | Every budget came from a 216 px floor that only exists when a desktop user drags the splitter to its minimum. Below 900 px the doc pane is full width; by default it is 40 % of the workspace. The stage stopped at 480 px even in a wide pane. | `styles.css` `minmax(260px, …)`, `@media (max-width: 900px)` |
| 4 | Still frames, no motion, no knobs. | — |
| 5 | Ghost rows ("not used") and private glyphs (‖ ○ ◌) without a legend. | Old `Stage.tsx` `GhostRow` |

What the old engine got right stays: Go's rules for channels, select, mutex,
wait group, timer, and context; the README diagram as the door; pins checked
by `make lint`; constants that name their source line; the spoiler and
vocabulary rules; screen-reader text; reduced motion.

## 2. Shape

```
 specs/<id>.ts            nodes + programs (generators) + knobs + scenes
        │
 engine/sim.ts            scheduler: runs the programs under Go's rules on a
        │                 virtual clock; seeded choice where Go promises no
        │                 order; derives states, edges, outcome, verdict
        ▼
 Run = steps (event, moves, world snapshot)
        │
 engine/timeline.ts       beats: time beats (clock moves, work bars fill)
        │                 and batches (clock still, values fly)
 engine/layout.ts         grid → pixels; turns top to bottom when narrow;
        │                 bends an edge that would cross a node
        ▼
 view/Player.tsx ── view/Graph.tsx (SVG) ── view/CodePanel.tsx
        ▲
 VizDoor.tsx (README fence)   VizSolution (top of the revealed solution)
```

The whole run is computed before playback. Playback only moves a position
along the timeline, so Step back, the scrubber, a replay, the checker, and
the screenshots all see the same schedule.

## 3. Decisions

| # | Decision | Reason |
| --- | --- | --- |
| D1 | **A spec is a program, not a schedule.** Each goroutine is a generator that yields one operation per Go statement. | The scheduler places every event in time, so a frame cannot show a state Go would not produce. Specs got shorter: 06 went from 176 lines of steps to about 140 lines with code and tests. |
| D2 | **A graph, not rows.** Goroutines and channels are nodes; edges come from what the run did (send, receive, close, go, Done, Wait, Lock). Values are tokens that keep their identity as they move. | The topology is the lesson. A token sitting in a full channel is backpressure; a goroutine that stays amber after main returns is a leak. |
| D3 | **Design for the normal pane, then degrade.** Nodes keep a readable size; under about 116 px per column the grid turns so data flows top to bottom; a graph that still overlaps is laid out wider and drawn scaled down; an Expand button opens a large view. The checker requires at least 90 % scale at a 640 px pane and 60 % at 300 px. The 216 px budgets are gone. Pixel checks run at 300 and 640 px. | The common doc pane is 400–750 px wide. A layout tuned for the rare floor was cramped everywhere. |
| D4 | **Code panel by tier.** Today shows scaffold lines, verbatim. Goal shows no code. Inside shows solution lines, verbatim. The gutter marks the line each goroutine is on. | The Problem tab must not show the answer, and the README diagram already gives away the goal's shape. Verbatim lines are checked, so the excerpt cannot drift. |
| D5 | **Words: one insight per scene, a live status line, optional stops.** The status line names the latest event while playing and the verdict at the end. A stop pauses playback and shows a caption, at most three per scene. | A caption on every step was the old engine's way to explain still frames. With motion, one or two sentences and a few pauses are enough. |
| D6 | **The clock stands still while values move.** Steps at one instant form one batch until a value would move twice. Problem scenes on one door share one pace. | Channel operations take no time in Go. Independent moves (ten workers finishing) play together; a chain (receive, then forward) plays in order. A shared pace keeps Today and Goal durations honest. |
| D7 | **Seeded randomness, checked under 12 seeds.** Wake-ups at one instant, ready select cases, and mutex waiters are chosen with a seed. A shuffle button appears when another seed gives another order. | Go promises no order there. A scene whose outcome depends on the seed is a lie; the checker refuses it. |
| D8 | **One palette.** Running blue, blocked amber, returned dashed grey, not started dotted grey, leaked or deadlocked or panicked red. Tokens in three tones. A legend sits under every graph. Colours are CSS tokens in all three theme blocks. | The reference page's palette reads at a glance in both themes; the legend removes the guessing. |
| D9 | **Knobs where they show the lesson.** 18's Goal has `cap(ch)` 0, 2, 20. | Changing one number and watching the stall move teaches faster than prose. |
| D10 | **The door plays on open.** The Solution block starts paused. Reduced motion never autoplays and jumps between batches instead of flying values. | The learner pressed "▶ Today", so playing is the expected answer; the solution block appears on page load. |
| D11 | **Kept rules from the old record.** One goroutine is one node in every scene of a spec. A scene models one run. Numbers come from constants with source lines. A test is marked only where the real test can reach its verdict. Problem labels use the learner's words; no Problem text names a solution-only identifier. An author never edits the engine to make one spec work. | Each rule caught a real defect in the first engine (old decisions 31, 79, 50, 23, 44). |

## 4. Files

| Path | Role |
| --- | --- |
| `web/src/viz/engine/model.ts` | Types: nodes, operations, scenes, the run |
| `web/src/viz/engine/ops.ts` | The author's vocabulary |
| `web/src/viz/engine/sim.ts` | The scheduler and Go's rules |
| `web/src/viz/engine/timeline.ts` | Beats, positions, step navigation |
| `web/src/viz/engine/layout.ts` | Grid to pixels, portrait, edge routes, token anchors |
| `web/src/viz/view/Player.tsx` | Transport, scrubber, knobs, words, code, transcript |
| `web/src/viz/view/Graph.tsx` | SVG nodes, edges, tokens |
| `web/src/viz/view/CodePanel.tsx` | The excerpt and its gutter |
| `web/src/viz/VizDoor.tsx` | The README door and the Solution block |
| `web/scripts/viz-check.ts` | Provenance, spoilers, runs under 12 seeds, budgets, layout |
| `web/scripts/viz-kit.test.ts`, `viz-check.test.ts` | The engine's rules; planted faults |
| `web/scripts/viz-shots.ts` | Pixel checks and review frames |

## 5. Extending the engine

| Need | Change |
| --- | --- |
| A new Go primitive (`sync.Cond`, `errgroup`) | A node kind in `model.ts`, its operations in `ops.ts`, its rules in `sim.ts` (with tests in `viz-kit.test.ts`), its shape in `Graph.tsx`, its size in `layout.ts`. No spec changes. |
| A new operation on an existing kind | `ops.ts`, `sim.ts`, a test. |
| A new visual state | A CSS token in all three theme blocks, the legend, and this record. |

A schema change bumps `schema` and migrates every spec in the same change.

## 6. Guards against jank

Jank passes still-frame checks, so motion has its own guards.

| Guard | What it stops | Where |
| --- | --- | --- |
| Continuous scrubber (`step="any"`) | A range input snaps its thumb and fill to `step`; a coarse step made playback jump in 1 % hops while time ran smoothly. The player handles the arrows itself, so the input needs no step. | `view/Player.tsx` |
| Motion check in `viz shots` | Plays every scene of every spec in real time and samples each frame: the thumb must sit within 0.2 % of the playback position, no more than two frames may pass 34 ms, and playback must actually move. It was proved against the coarse-step bug: it fails with it, passes without. | `scripts/viz-shots.ts` |
| Timeline invariants in `check-visuals` | Every beat has a finite positive duration, beats are contiguous, the total is their sum, the clock never runs backwards, and every matched stop lands on a batch end. | `scripts/viz-check.ts` `checkTimeline` |
| Short flights | The clock stands still while a value flies, so a long flight reads as a stalled clock. A hop takes 320 ms, a hand-off through a channel 440 ms, a state change 180 ms. | `engine/timeline.ts` |
| First frame sets the start | A frame timestamp can precede `performance.now()`; taking the start from `now()` gave a negative first step that paused playback twice on the same stop. | `view/Player.tsx` |
| Static work is memoized | The player re-renders every frame, so highlighting code and running the scene are computed once per spec, not per frame. | `view/CodePanel.tsx`, `Player.tsx` |

When playback feels wrong, measure before guessing: frame times first (the
page was never slow here: 16.7 ms every frame), then what the browser draws
against what playback asked for.

## 7. Known limits

| Limit | Workaround today |
| --- | --- |
| No periodic `time.Ticker` kind | A timer the goroutine resets on every tick |
| A goroutine blocked on an old channel when the variable is remade | Give the old channel its own node; `remake` refuses this case |
| One run per scene; no live trace of the learner's code | Scenes model `main()` or one named test, from committed code |
