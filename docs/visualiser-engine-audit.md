# Visualiser engine audit

> **Superseded on 2026-11-07.** The visualiser was rebuilt as a scheduler and a graph view. The current design and its decisions are in `docs/visualiser-design.md`; the authoring contract is `.claude/skills/new-visualisation/`. This file is kept as history.

> **Non-normative audit input.** The architecture is `docs/visualiser-artist-review.md`. This document is verified evidence for that review and for the implementation plan, not the authoring contract.

Input for the visualiser artist review (`docs/visualiser-artist-brief.md`).
Synthesised from four area audits — UX/accessibility, extensibility, placement, visual craft — after an adversarial verdict pass. Every claim below survived that pass; where a draft claim was wrong, the correction is stated. No code was changed.

## 1. Verdict

**What works.**
- The core shape is right: a spec is data (`web/src/viz/spec.ts:7-17`), a pure fold turns steps into a frame (`web/src/viz/fold.ts:52-75`), and a view renders it. Nothing reads a clock or the learner's code.
- The registry emits one chunk per spec through literal `import()` (`web/src/viz/registry.ts:5-11`). The player and both views are small.
- Inline placement is the correct default at the 260 px pane floor. A third tab does not fit: three tabs need about 370 px with the passed badge and 307 px without, against a 260 px pane.
- The doc split the owner asked for is already implemented: `.go` files come from `git HEAD`, every `.md` from the working tree (`web/tools/gen/main.go:126-136`, `web/scripts/prepare.sh`). One asymmetry remains, in `viz-check` (issue 9 below).

**What does not work.**
- The state vocabulary teaches the wrong lesson: `blocked` and `parked` map to the failed state and render red (`fold.ts:124-128`, `styles.css:1272-1275`). Normal backpressure looks like an error.
- No renderer draws a channel, a send, a receive, or a gate. `gate` and `note` events are dead (`spec.ts:14,17`; no view reads `frame.gates` or `frame.notes`).
- Chrome outweighs the diagram at 216 px. Exercise 04 is 506 px tall: diagram 33%, controls 11%, a 7-line disclaimer under a 4-line caption (`VizPlayer.tsx:124-127`).
- The figure sits where few learners reach it: 68-77% down the Problem document and 89-93% down the Solution document (`DocPane.tsx:56-64`).
- There is no normative authoring contract. `web/README.md:46-54` lists files; it does not define fields, tiers, vocabulary, or limits.

**Highest-leverage change.** Replace the two chip grammars (lanes and boards) with one stage grammar — actor rails, channel slots, tokens, arrows, verdict strip — and make the state vocabulary semantic in the same pass (amber `wait`/`park`). The cheapest shippable slice, if one scene must ship first, is the lane frame: actor name and state on a line above a full-width track, state chip off the track, wait in amber.

## 2. Verified issues, ranked

### High

| # | File:line | Claim | Fix |
|---|---|---|---|
| 1 | `web/src/viz/fold.ts:124-128` | `blocked`/`parked` become the failed state; 18's intended backpressure and 31's expected select park are red. | Add `wait`/`park` states: amber, dashed outline, pause glyph, word. Reserve `--fail` for a violated contract or a failed test. |
| 2 | `web/src/viz/views/LaneView.tsx:65-72` | Marker labels exist only in `title`; PASS, FAIL, "no overlap", "resCh wins" are invisible at 216 px and to touch, keyboard and print. | Draw a visible glyph plus short word, or a footer verdict strip. Keep `title` as a supplement only. Note: `.viz-track` has `overflow:hidden` (`styles.css:1198`), so place labels outside the track. |
| 3 | `web/src/viz/views/LaneView.tsx:73-75` | The state chip overlays the track, is 8.5 px, and `phase ?? state` replaces the state word ("DONE", "BLOCKED: S…"). | Move the chip to a line under the lanes or above the track. Render `state` and `phase` together. Floor type at 10.5 px. |
| 4 | `web/src/viz/VizPlayer.tsx:121` | `aria-live` is `off` exactly while the figure changes on its own; the step count is `aria-hidden` (`:75`). A screen-reader user hears nothing during Play. | Add an always-polite visually hidden region with step number and caption. Remove `aria-live` from the figcaption and `aria-hidden` from the counter. Add an `.sr-only` rule. |
| 5 | `web/src/viz/specs/18-bounded-pipeline-backpressure.ts:20,51` | The scaffold scene has 41 near-identical steps and no seek control. Pressing Step 40 times is the only path. | Collapse to 5-6 steps with absolute `set:` counters (keep gaps 0, 1, 18, 19 and the "all 20 items" fact). Make transcript rows seek buttons. |
| 6 | `web/src/components/DocPane.tsx:63-64` | The fix visual mounts after the entire solution, so the learner reads the whole answer first. Measured at 89-93% of the document. | Anchor the panel at the winning `## Approach` heading, or add a "Fix in motion" jump at the reveal. The Problem panel has the same problem at `:56-57`. |
| 7 | `web/src/viz/spec.ts:85` | `tier: "symptom" | "fix"` does two jobs: tab visibility and pedagogy. 04's trap and 31's leak are mechanisms tagged `fix`. | Split into `role` (`symptom|mechanism|trap|fix`) and `gate` (`safe|spoiler`). Tab visibility follows `gate`; slot follows `role`. Needs a schema version and pilot migration. |
| 8 | `web/scripts/viz-check.ts:59-72` | The check imports `specs/<id>.ts` by filename, not through `loadViz`. A 06 registry entry pointing at the 04 spec passes `tsc` and the check. | Iterate the registry loaders and assert `default.exerciseId === key`. Add a mount-time assert in `VizPanel`. |
| 9 | `web/README.md:46-54` | No normative contract: no required fields, tier semantics, event vocabulary, naming, placement, or check order. Neither `new-exercise` nor `judge` mentions the visualiser. | Write `.claude/skills/new-visualisation/SKILL.md` plus `REFERENCE.md`, symlink it under `.agents/skills`, and link it from `AGENTS.md` and `web/README.md`. |
| 10 | `web/scripts/viz-check.ts:114-127` | Reference checks cover actors, `msg` endpoints and cell ids only. Undeclared counters and rules are silently invisible; an unknown cell state falls back to "· state". | Validate counter ids, rule ids, cell states, and uniqueness of scene/actor/board/cell ids. |

### Medium

| # | File:line | Claim | Fix |
|---|---|---|---|
| 11 | `web/src/viz/VizPlayer.tsx:37` | Play advances every 900 ms, or 250 ms for scenes over 20 steps, regardless of caption length (18's longest is 136 characters). | Pace by caption length: `clamp(1200, caption.length * 55, 6000)`. Do not use a step-count threshold. |
| 12 | `web/src/viz/VizPlayer.tsx:62-69` | Reduced motion stops only the initial autoplay; Play and Replay still auto-advance. | Under `reduce`, the primary button steps once and is labelled "Next step"; at the end it restarts. Do not early-return in a way that kills Replay. |
| 13 | `web/src/styles.css:1425-1426` | Caption height swings from one to six lines; `overflow-wrap:anywhere` splits Go identifiers. | Cap captions at about 90 characters in the specs and in a check. Set `min-height` for two lines only. Keep wrapping as a fallback. |
| 14 | `web/src/styles.css:1200-1210` | The muted threshold line uses `opacity:.55`, about 2.3:1 against the track — below the 3:1 non-text floor. | Set `opacity:1`, give fail a solid border and the neutral a dotted one. Keep labels in the existing chip row; do not put them on the track (they clip and collide). |
| 15 | `web/src/styles.css:1102` | Dark-mode elevation is inverted inside the figure: children are darker than the card, unlike light mode. | Add viz-local tokens (`--viz-surface`, `--viz-cell`). Include `.viz-track`, the scene select, `.viz-limit` and `.viz-message`, not only counters and cells. |
| 16 | `web/src/styles.css:1265` | Semantic text is 8.5-10 px (state, cell name, span label, lane label). | Set a 10.5 px floor for semantic text; 10 px only for axis ticks. |
| 17 | `web/src/viz/specs/18-…:120-131` vs `:214-227` | 18 switches from lanes to gauge between symptom and fix, so the learner cannot compare the frames. | Keep one family per exercise, or give both families one stage grammar. |
| 18 | `web/src/viz/VizPlayer.tsx:100-113` | Play wraps to a second row at 216 px and Restart leads the tab order. | Put Play first in the DOM, use a two-column grid with Play full-width, move Restart last, rename "Step" to "Next step", set a 32 px control floor. |
| 19 | `web/src/viz/specs/04-graceful-sigint.ts:105,162` | Scene labels truncate in the native select ("Fixed: both signals h"). 31's 40-character label also truncates. | Cap scene labels at about 20 characters. Give the select the full row. Put the long text in `scene.summary`. |
| 20 | `web/scripts/viz-check.ts:133-137` | Any `.ts` in `specs/` without a registry entry fails, so a copy-me `_template.ts` fails the check. | Skip `_`-prefixed files, or keep the template outside `specs/`. |
| 21 | `web/scripts/viz-fold.test.ts:8-10` | The fold test imports the three pilots explicitly; a new spec gets no pinning assertion and nothing fails. | Import `vizIds` and require at least one `frameAt` assertion per registered spec. |
| 22 | `web/src/viz/VizPlayer.tsx:72,121,124,129` | `<figcaption>` is neither first nor last child of `<figure>`; the figure `aria-label` changes every step. | Close the figure after the figcaption, or move the note and transcript outside. Do not drop the label without a stable replacement. |
| 23 | `web/src/components/VizPanel.tsx:16` | The spoiler gate is a render filter only: the Problem tab imports the whole spec chunk, fix scenes included, before the reveal. | Split chunks by gate, or state in the contract that the gate is visual only. Owner-level decision. |

### Low

| # | File:line | Claim | Fix |
|---|---|---|---|
| 24 | `web/src/viz/views/LaneView.tsx:100` | A blocked message shows state by colour only; the word "blocked" never appears. Latent: no pilot emits `msg`. | Prefix "blocked: " or add a stop glyph plus word before the first scene uses `msg`. |
| 25 | `web/src/viz/fold.ts:82-87` | `exit` always sets `done`, so a killed goroutine reads as success (green done beside a red dead lamp in 04). | Distinguish `exit` from `dead`; give the exit event a reason or tone. |
| 26 | `web/src/components/DocPane.tsx:27-33` | `role="tablist"` has no tab panel, `aria-controls`, roving tabindex or arrow keys; the spacer and badges are non-tab children. | Either drop the tab roles (and `aria-selected`) or implement the full tab pattern and move the badges out. |
| 27 | `web/src/components/VizPanel.tsx:32` | The panel renders `null` while the spec chunk loads, so the page jumps when the figure appears. | Render a reserved-height skeleton or keep the disclosure summary and show "Loading…". |
| 28 | `web/scripts/viz-check.ts:90` | The site renders working-tree READMEs, but the check judges the HEAD README. A live edit can invalidate the pairing before it is committed. | Read `.md` from the working tree or index in dev, HEAD in CI. Keep `.go` at HEAD always. |

**Corrections made during verification.** (a) The threshold lines are not colour-only: fail also changes opacity, and the limit chips carry distinct text. Keep the contrast fix, drop that claim. (b) `VizPlayer.tsx:125` uses `browserNote ?? default`, never both; only the GOMAXPROCS sentence is duplicated everywhere. (c) Do not add `aria-label` to the scene select: it overrides the visible "Scene" label with a value that changes on selection. (d) `package.json:5-7` already declares `engines.node >=22`; the earlier "no Node floor" finding is obsolete.

## 3. Authoring contract proposal

**What a new visualisation is.** One module `web/src/viz/specs/<exercise-id>.ts` exporting `default` a `VizSpec`. It is data only: scenes, steps, events, provenance. It contains no JSX, no styling, no imports from views, no clock, no randomness, and no reference to the learner's code.

**The write set (nothing else).**
1. Create `web/src/viz/specs/<id>.ts` from the template.
2. Add one literal `import()` entry in `web/src/viz/registry.ts`.
3. Add one pinning assertion per spec in `web/scripts/viz-fold.test.ts`.
4. Optional: pair the spec with the exercise README's ASCII diagram (a `diagram` provenance token), never replace the diagram.

**The template.** Copy from the canonical worked scene (18's bounded scene, or 31's deadline scene) and keep its shape. Keep the template outside `specs/`, or name it `_template.ts` and make `viz-check` skip `_` files, because a `.ts` in `specs/` without a registry entry fails today (`viz-check.ts:133-137`).

**Scene model (proposed).**
- `role`: `symptom` (the scaffold fails), `mechanism` (how the pattern works), `trap` (a plausible failed fix), `fix` (the answer).
- `gate`: `safe` (may render before the reveal) or `spoiler` (Solution only). The Problem tab shows `symptom` and `safe` mechanisms; the Solution tab shows `trap` and `fix`.
- `defaultScene` declared explicitly. Today the default is array order (`VizPlayer.tsx:21`), so 04 opens on a trap and 31 on a success by accident.
- Layout rule: `lanes` when time order or overlap is the lesson; `gauge` when slot, permit, or test state is the lesson. Never mix event kinds a view ignores.
- Rendered vocabulary: lanes draw spawn, exit, phase, span, marker, msg; gauge draws spawn, exit, phase, cell, counter; both draw counter. Ban `gate` and `note` until a view reads them. Reject span/marker/msg in a gauge and cell in lanes.
- Content budget: at most 3 actor rails, 2 channels, 2 thresholds, 2 verdict rows; 5-8 steps typical, 12 hard maximum, or a seek control; caption under 90 characters; actor and scene labels under 20.
- Provenance: every constant has `value` and `source` as `path:line`; every anchor is a literal substring of a HEAD `.go` file, and at least one anchor comes from the scaffold, not the solution doc.

**Registry rule.** One literal `import()` per spec. Never build the path from a variable; Vite cannot see it (`registry.ts:6-7`).

**Checks the contract must name, in this order.**
- A: every registry key loads and `default.exerciseId === key`.
- B: unique scene, actor, board and cell ids; `t` monotonic; `outT` above the last `t` on a lanes scene.
- C: every counter id is declared; every cell state exists in `board.states`; every rule `at` is inside the axis.
- D: no dead event kinds; no event kind the chosen layout cannot draw.
- E: constants' `source` resolves at HEAD to the stated identifier and value (needs a normalised `path:line` format first).
- F: the README diagram token exists; the `.md` source matches the site's working-tree rule.
- G: at least one frame assertion per spec; final frame preserves the lesson's key object; one family per exercise.
- H: caption length, step count, scene-label length, marker/label visibility (static only; a true 216 px geometry check needs a layout engine, which the dependency rule forbids).

**Dumb-agent walkthrough for 06.**
1. Read `docs/visualiser-artist-brief.md`, the contract skill, and `web/README.md` visualisations section.
2. Run `cd web && npm run prepare-data`.
3. Read `06-fan-out-fan-in/README.md` from the working tree; read code only with `git show HEAD:06-fan-out-fan-in/<file>`.
4. Choose scenes: `symptom` (ten sequential 150 ms spans against a 500 ms budget) and `fix` (ten fan-out lanes plus a collector at about 150 ms). Both same family.
5. Copy the template. Fill events, counters, one verdict strip, provenance anchors from HEAD and the test budget.
6. Add the registry literal. Add the fold pin: final `elapsed` is 1500 and 150; `spans.length` is 10.
7. Run `npm run check-visuals`, `npm run test-visuals`, `npx tsc --noEmit`, `npx vite build`, `npm run smoke`, `make lint`.
8. Stage explicit paths only. The commit gate does not run the web checks (`tools/check/hook.go:69-91`), so CI is the first full gate.

**Never touch.** `web/src/viz/spec.ts`, `fold.ts`, `VizPlayer.tsx`, `views/*`, `registry.ts` beyond one literal entry, `web/src/components/VizPanel.tsx`/`DocPane.tsx`, `web/src/styles.css`, `web/src/generated/*`, any exercise `.go` file, `solutions/*`, `docs/*`, and the root README table.

## 4. Placement and timing

| Role | Where | When the learner sees it | Default state | Gate |
|---|---|---|---|---|
| Symptom | Problem tab, inline, after the README section that describes the failure (diagram, problem, or "Your task"), not after the pager | On opening Problem, as an affordance in the reading flow; auto-expand once only if the run failed | Collapsed, paused at step 1, first frame legible without motion | None; the label names the failure, never the fix |
| Mechanism (safe) | Problem tab, after the symptom, behind a second "See how it works" disclosure | Only when asked, or after a failed run | Collapsed, paused | Second explicit gate |
| Mechanism (spoiler) | Solution tab, before the approach code | After the reveal | Collapsed, paused | Reveal |
| Trap | Solution tab, first fix scene | After the reveal; default scene where declared | Paused | Reveal |
| Fix | Solution tab, at the winning approach heading or a "Fix in motion" jump, not after the whole doc | After the reveal | Paused; declared default | Reveal |

**Third-tab promotion conditions.** Promote only when all hold:
- **P1 width:** pane at least 380 px with badges in the row, or 320 px if badges move out. Measured: three tabs need about 370 px with the passed badge and 307 px without.
- **P2 content:** at least 3 scenes across at least 2 roles, or a visual-first exercise where the visual is the main teaching artifact.
- **P3 discovery:** inline cannot work: no README section to anchor to, or the panel would sit more than about two viewports down. Scope this to the Problem tab; the Solution figure is already 7.5 viewports down.
- **P4 safety:** at least one scene is safe before the reveal.
- **P5 fallback:** below the width breakpoint the tab becomes an inline affordance; it must not vanish.

Deep links: `?scene=<id>&step=<n>`, validated against `spec.scenes`, clamped, and spoiler-safe (never auto-reveal a fix scene). The router must change first: `parseRoute` ignores `location.search`, `useRoute` listens only to `popstate`, and `navigate` compares path and hash (`web/src/router.ts:9-13,22-26`).

## 5. Visual language and the canonical 216 px scene

**Grid and type.** A 4 px base unit, 10 px figure padding, one column. Four sizes: title 12.5/16, caption 12/17, label 11/14 mono, annotation 10/13 mono. No semantic text below 10.5 px.

**Colour roles.** `work` = accent; `flow` = accent solid arrow; `wait` = a new amber token; `pass` = pass; `fail` = a violated contract or failed test only; `limit` = muted dashed, red only after it is crossed. Every state also has a shape and a word.

**Notation.** Goroutine = a 1.5 px vertical rail with its name above and a terminal tick at exit. Process = a 1 px bracket with a lamp. Buffered channel = N outlined slots with a capacity bracket; unbuffered = one hollow slot marked `cap 0`. Send/receive = an 8 px token on a 1.5 px orthogonal arrow. Blocked send = the token at the rail, a dashed amber arrow to a full slot, the word `blocked: send`. Select = a branch with one solid winner and one dotted loser. Verdict = a footer row with check/cross and a short test alias.

**Canonical scene at 216 px** (18's blocked frame): title 16 px; one transport row 28 px; gap meter 22 px; one axis line 14 px; producer row 34 px; channel strip with two 28x20 slots 32 px; consumer row 34 px; verdict strip 28 px; caption up to two lines 34 px; one footnote line 14 px. Diagram about 60% of the figure, against 27% today. The eye lands on the amber dashed arrow at the channel, which is the argument of the scene.

**Density and motion.** At most three rails, two channels, two thresholds, one meter, two verdict rows; more belongs in the transcript. Motion: 100-160 ms transitions only for causal moves (token travel, slot fill, state word). No looping or pulsing. Reduced motion makes every change instant and starts paused.

## 6. Prioritized plan

**Phase 1 — truth and legibility.** State vocabulary (wait/park/exit), lane frame rebuild (name and state above the track, chip off the track), always-on live region, caption-paced playback, reduced-motion step mode, caption and label caps, transcript seek, visible marker labels. Cut: new families, deep links.
Acceptance: 18 takes at most 6 steps or has seek; no meaning lives in `title`; captions do not reflow more than two lines; keyboard-only play/step/seek works; light and dark at 216 px with no horizontal overflow.

**Phase 2 — one stage and the contract.** One stage renderer; role x gate; contract skill plus template; checks A-D and F-G; panel heading and section anchoring; fix panel before the prose. Cut: third tab, deep links, motion.
Acceptance: a context-free agent adds 06 following only the contract; seeded defects (wrong registry entry, unknown counter, long caption, mixed family, title-only label) each fail a named check; the Problem disclosure names the fix scenes.

**Phase 3 — coverage and polish.** Migrate 04 and 31 to the stage grammar; deep links; deep-link router support; contrast and dark-token fixes; unified verdict strip; optional third tab only where P1-P5 hold. Cut: anything that needs a new dependency.
Acceptance: all pilot scenes share one notation; the final frame keeps the lesson's key object; `?scene=&step=` restores behind the spoiler; no dependent on a charting or animation package.

## 7. Open decisions for the artist

1. One stage grammar for both families, or keep lanes and gauge as two grammars with shared primitives? The craft audit argues for one; the extensibility audit warns that gauge semantics (slots, permits, test state) may not fit a time rail.
2. Is the `role` x `gate` split a breaking schema change now, or an additive field with the old `tier` kept for one release? There is no schema version field today.
3. Where exactly does the fix panel go: at the `## Approach` heading, or at the top of the revealed branch? Rendering at a heading needs a section-splitting API; `Markdown.tsx` renders one HTML string, and the pilot READMEs have no problem or diagram heading to anchor to.
4. Should the Problem panel move before "Your task"? That breaks the current "after the README" rule and needs new headings in 04, 18 and 31.
5. Is a symptom scene mandatory for every exercise, and is a fix scene mandatory when a solution doc exists? Both are policy, not engine facts.
6. Is a purely visual spoiler gate acceptable? The Problem tab loads the whole spec chunk, fix captions included.
7. Should `check-visuals` join the pre-commit gate? It adds Node and a possible Go toolchain download to every qualifying commit.
8. How should `viz-check` read `.md`? Working tree in dev and index at precommit, HEAD in CI. `.go` stays at HEAD; splitting anchors by source is required.
9. How do we enforce 216 px quality without a layout dependency? Static budget checks plus DOM-free fold assertions are possible; a true geometry check is not, unless the no-dependency rule is relaxed.
10. Do the research docs (`docs/visualisation-catalog.md`, `docs/visualisation-handoff.md`) get marked non-normative and committed, or stay local? They currently contradict the engine on a third tab, vertical axes, dials, and an older event model.
11. Is a 90-character caption cap acceptable when it forces rewriting the 132-character 18 verdict caption? If not, the cap must be a warning, not a failure.
12. Do we ever ship a third tab, or is "wide pane only" a non-goal? The 260 px floor and the 320 px phone both fail P1.
