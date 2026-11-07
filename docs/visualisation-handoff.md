# Visualisation tab: research and handoff

> **Superseded on 2026-11-07.** The visualiser was rebuilt as a scheduler and a graph view. The current design and its decisions are in `docs/visualiser-design.md`; the authoring contract is `.claude/skills/new-visualisation/`. This file is kept as history.

**Status:** research complete; the pilot player and three specs are implemented.
**Date:** 2026-11-05.
**Reader:** the agent that will design and build the visualisations.
**Repository:** `/Users/loi.nguyenhuynh/Desktop/Personal/go-concurrency-exercises`.

**Implemented in this checkout:** the 12 missing README diagrams, the typed player under `web/src/viz/`, the 04/18/31 specs, the inline Problem/Solution panels, `npm run check-visuals`, `npm run test-visuals`, and the CI steps. The third tab is not built; §6 is the promotion plan.

**Data source:** Go code comes from `git HEAD`; Markdown docs (the root README, exercise READMEs, and solution docs) come from the working tree. Older notes in this document that say “HEAD only” describe the research state, not the current generator.

> **Non-normative research.** This is the research record and the implementation plan. The normative authoring contract will be the visualiser artist's review plus the `new-visualisation` skill. Where this document and that contract disagree, the contract wins.

---

## 0. The short answer

Yes, add visualisations. The idea is sound. But do not start with 43 animations or a third tab on day one.

The research reviewed all 43 exercises. Each proposal got an independent adversarial check against the committed code. The result:

| Tier | Count | What it means |
| --- | --- | --- |
| A — build first | 3 | The pilot. It proves the player on three genuinely temporal lessons. |
| B — build next | 9 | The ten `high` proposals, minus the two in A, plus 08. |
| C — build later | 16 | Real value, but the README or a shared renderer must come first. |
| D — do not build | 15 | The README, the test message, or a static diagram already carries the lesson. |
| `must` | 0 | No proposal survived as an unconditional need. |

Three findings drive the plan:

1. **The README ASCII diagram is the only artifact that works in every mode.** Lint already requires it (`tools/check/lint.go:256`). Twelve READMEs still lack it (`tools/check/lint.go:39-50`). Draw those first. They cost minutes and serve GitHub, a clone, and the site.
2. **A scripted animation is a model, not a trace.** The browser runs `GOMAXPROCS=1` and has no race detector (`web/README.md:42-44`). Every scene must say that it shows one possible interleaving.
3. **Most exercises do not need motion.** The best candidates are the ones where *when* something blocks, *which* goroutine is parked, or *what* keeps running after a return is the lesson.

Recommended shape:

- **Web only** for the interactive layer.
- **One shared player** plus a small set of renderers. Exercises supply data, not components.
- **Start inline:** a collapsed “See it happen” panel in the Problem tab (scaffold symptom), and a second panel in the Solution tab after the existing reveal (fix scenes). This avoids a second spoiler gate and the 260 px tab-row overflow.
- **Promote to a third tab** after 3-5 scenes ship and the width and accessibility tests pass. The same component moves into the tab. The exact promotion plan is §6.

If you want the third tab immediately, §6 is a complete plan. The player is still the long pole.

---

## 1. The two design questions

### 1.1 Third tab, or inside the existing tabs?

| Option | Strengths | Costs | Verdict |
| --- | --- | --- | --- |
| Third tab now | Clear home; deep link; full pane; fits the name | `.doc-tabs` already overflows at the 260 px pane floor (`web/src/styles.css:506`, `:540-559`); fix scenes need the reveal gate lifted; the tab exists on only some exercises | Not first. Promote after the pilot. |
| Panel in Problem + panel in Solution | Zero routing change; the symptom sits beside the task; the fix sits behind the existing gate; no empty tab | Less discoverable than a tab; no per-scene deep link | **v1** |
| Panel only in Solution | Safe by construction | The learner sees it only after the answer; loses the “see the bug while solving” moment | No |
| Panel only in Problem | Visible while solving | Spoils the fix unless every fix scene is removed; then it duplicates the README | No |

**Recommendation.** Build the player and ship it inline first. Promote to a third tab when it has enough users: at least 3-5 scenes, a green type-check, and a width test at the 260 px pane floor. This gives you the tab you want without making the tab the first risk.

The tab is the right long-term home. The evidence does not support it as the first step.

### 1.2 Both modes, or web only?

| Mode | What it can carry | What it cannot carry |
| --- | --- | --- |
| GitHub README | Text, tables, ASCII diagrams, static images | Scripts, interactive HTML, animation |
| Clone + `go test` | Everything above, plus real output and `-race` | An interactive widget unless the learner runs `cd web && npm run dev` |
| Deployed site | The interactive player | `-race` |

**Recommendation: web only.** The interactive layer is React under `web/src/`. A clone that runs the web app gets the same code. A clone that reads GitHub gets the README ASCII diagram. Do not duplicate a scene in Markdown; the second copy will rot.

Consequences:

- The 12 READMEs without a diagram need one before or alongside their visualisation. They are: 06, 08, 09, 12, 13, 14, 16, 17, 20, 26, 29, 30.
- Add one absolute link in a README only if it helps: `https://<domain>/<id>/visualisation`. GitHub keeps it; the site’s Markdown renderer rewrites internal links (`web/src/markdown.ts:36-57`).
- Do not add image files to an exercise folder. Lint forbids it (`tools/check/lint.go:154`).

---

## 2. What the research found

### 2.1 The numbers

- 43 exercises, 43 proposals, 43 verifier passes.
- 0 `must`, 10 `high`, 33 `nice`, 0 `no` at the entry level.
- Every proposal needed a change. The verifier agreed with only one (18).
- The `high` tier: 04, 06, 13, 18, 19, 21, 22, 27, 28, 29.

The absence of `must` is the important result. The exercises teach with prose, tests that name the failure, ASCII diagrams, and worked solutions. Most animations restate one of those. The exceptions are timing, blocking, and interleaving: facts that prose cannot print.

### 2.2 The test for a visualisation

Use this test before building:

> Does the lesson depend on *when* something blocks, *which* goroutine is parked, or *what* keeps running after a return? If not, a diagram or a table is enough.

The best candidates pass one of three tests:

1. **The browser cannot run the exercise.** 04 imports `os/exec`, which the browser cannot back (`web/src/generated/exercises.json`). The site gives a Build button and no feedback.
2. **The browser run contradicts the lesson.** 19 and 38 pass their race tests on the scaffold under `GOMAXPROCS=1`. A visualisation must say “the browser cannot show this; run `-race` locally”, or it will teach a false success.
3. **The lesson is a schedule.** 13 (head-of-line blocking), 28 (returned does not cancel), 18 (a blocked send), 27 (a heartbeat resets a deadline), 21 (a wait-for cycle). These animations earn their cost.

### 2.3 What the research corrected

The verifier found load-bearing errors in many proposals. Do not animate the original scene text without reading the corrections in the catalogue. The most important:

| Exercise | Wrong in the first draft | Correct fact |
| --- | --- | --- |
| 04 | Scaffold has main + Run lanes; trap is “the fix minus one line” | `proc.Run()` runs on main (`main.go:21`). The trap is `<-sigChan; proc.Stop()`. `Stop()` never returns (`mockprocess.go:35-36`). |
| 08 | Receive-guarded half-guard is safe | Send-guarded passes; receive-guarded panics. Measured send blocks: 0. |
| 13 | Producers 2-4 start; the concurrent scene passes | Only producer 1 spawns; the hub blocks on `shardStream <- shard 1`. |
| 19 | The browser shows a lost update | The browser passes `TestAccountConcurrentSafety`. The actor blocks on the reply **send**. |
| 21 | `sync.Mutex` has a FIFO waiter queue | It barges. There is no FIFO promise. |
| 24 | Heap pops `1,3,2,5,4` | A priority-only heap pops `2,6,5,4,3`. Ties are unordered. |
| 25 | 20 jobs queue on the channel | `jobs` is unbuffered (`main.go:89`). At most one send is pending. |
| 26 | Scaffold stamps `ErrDivideByZero` | HEAD’s reciprocal returns (`main.go:120-125`). |
| 33 | Inbox send blocks at request 2 | Measured: 52 sends accepted; the 52nd blocks. The README is wrong. |
| 38 | 200 contenders overflow the strip | The browser passes the race test on the scaffold. |

The full list is in each entry’s **Verifier corrections** block.

### 2.4 Documentation bugs to fix first

A visualisation built on a wrong document teaches the wrong model at higher resolution. Fix these before the scene:

- `33-load-balancer/README.md:35-40` says the inbox send blocks at the second request. The measured threshold is 52.
- `solutions/08-pipeline.md` states the half-guard in the wrong direction.
- 25, 26, 36, and 37 frame counterfactual states as scaffold behaviour. Label them as counterfactuals or remove them.
- 34, 37, 38, and 39 cite stale `main.go` line numbers.

---

## 3. Design principles

1. **Scripted, not traced.** The player replays a hand-authored event list. It never instruments the learner’s code.
2. **One interleaving, labelled.** Every scene says “one possible schedule; Go does not promise this order”. Never draw a FIFO mutex or a deterministic `select` tie.
3. **Symptom before fix.** The default scene shows the scaffold. Fix scenes render only after the existing Solution reveal.
4. **One gate.** If a panel or tab can show a fix, reuse `revealed`; do not add a second “show me” button.
5. **Data, not components.** A new exercise adds a spec file. It does not add a React component.
6. **Vertical first.** Design for 216 px of content (260 px pane minus 44 px padding). One column. No horizontal scroll.
7. **Text alternative.** Every step has a caption. The SVG is `aria-hidden`. A `<details>` transcript lists every step.
8. **Reduced motion starts paused.** Step is the equal path to Play.
9. **No new dependency.** React, DOM/SVG, and the existing CSS variables.
10. **Drift guard.** A script checks that each spec’s constants still occur in `git HEAD`. Without it, the animation will lie after the next scaffold edit.

---

## 4. Architecture

### 4.1 The pieces

```
web/src/viz/
  spec.ts            types: VizSpec, Scene, Step, VizEvent
  fold.ts            frameAt(scene, i): pure; no clock
  VizPlayer.tsx      transport, caption, aria-live, transcript, gate filter
  views/
    LaneView.tsx     F1 lanes and F4 locks
    GraphView.tsx    F2 pipelines
    GaugeView.tsx    F3 buffers and permits
    HeapView.tsx     F5 heap / queue
    GridView.tsx     F6 cache and shard grids
    LatchView.tsx    F7 state machines and CAS
  registry.ts        literal id -> () => import("./specs/<id>.tsx")
  specs/
    04-graceful-sigint.tsx
    ...
```

The registry uses literal `import()` calls so Vite emits one chunk per spec. The player and views load only when the first scene opens.

### 4.2 The spec

```ts
type Tier = "symptom" | "fix";

interface VizSpec {
  exerciseId: string;          // must equal the folder id and the registry key
  family: "lanes" | "graph" | "gauge" | "lock" | "heap" | "grid" | "state";
  title: string;
  provenance: {
    constants: Record<string, { value: string | number; source: string }>;
    anchors: string[];         // substrings that must still exist in HEAD
  };
  browserNote?: string;
  scenes: Scene[];
}

interface Scene {
  id: string;
  label: string;
  tier: Tier;                  // decides where it can mount
  summary: string;             // figcaption and aria-label
  steps: Step[];
  layout: LaneLayout | GraphLayout | GaugeLayout | HeapLayout | GridLayout | LatchLayout;
}

interface Step {
  t: number;                   // logical milliseconds or step index
  caption: string;             // aria-live text
  events: VizEvent[];
}
```

The event union is in the catalogue and in the plumbing plan. The important rule: `frameAt` is a pure fold. Play, Step, the scrubber, and a deep link all read the same fold. Nothing reads `Date.now()`.

### 4.3 Mounting in v1

```tsx
// DocPane.tsx, problem branch, after the Markdown
<Markdown ... />
<VizPanel id={id} tier="symptom" />

// solution branch, only after revealed
<Markdown ... />
<VizPanel id={id} tier="fix" />
```

`VizPanel` returns `null` when the registry has no spec for the tier. It lazy-loads the chunk when it first renders.

A collapsed `<details>` wrapper in the Problem tab keeps the prose first:

```
▸ See it happen (scripted, one possible schedule)
```

### 4.4 Promotion to a third tab

Do this after 3-5 scenes ship. The full plan is §6. In short:

- Add `"visualisation"` to `Route.tab` (`web/src/router.ts:6`).
- Add one conditional anchor in `DocPane.tsx:26-40`, labelled “Visualisation”.
- Lift `revealed` from `DocPane` to `ExerciseView` so the fix scenes keep the same gate.
- Let `.doc-tabs` wrap (`web/src/styles.css:540-547`).
- Keep the inline panels or remove them. Do not ship both.

### 4.5 Checks

| Check | What it proves |
| --- | --- |
| `npx tsc --noEmit` | Spec types and unused imports |
| `web/scripts/viz-check.ts` | Registry key = exercise id; anchors still in HEAD; steps monotonic; no empty scene |
| `node --test` over `frameAt` | Every scene reaches its declared outcome |
| `vite build` | One chunk per spec; the main bundle does not grow |
| Headless Chrome at 260 px and 320 px | No horizontal scroll; controls at least 32 px; focus ring; light and dark |
| `npm run smoke` | The Go runner is unchanged |

Add the type-check and `viz-check` to `.github/workflows/check.yml:38-41`. Today the web job runs only `prepare-data` and `smoke`.

---

## 5. Exercise catalogue

The table gives the decision for every exercise. The full entries for Tier A and Tier B follow. Tier C and Tier D are decisions only; their designs, scenes, and verifier corrections are in the catalogue.

Read the verifier corrections before the design. They override the first draft where they conflict. Several corrected designs also recommend a third tab. That is a per-exercise opinion. The set-level decision in §1.1 overrides it: inline first, tab after the pilot.

| # | Exercise | Tier | Form | Effort | README diagram | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | [Graceful SIGINT Killing](#04-graceful-sigint) | A | goroutine lanes | M | yes | The browser cannot run this exercise at all; the signal mailbox and the parked Stop are visible only as time. |
| 18 | [Bounded Pipeline with Backpressure](#18-bounded-pipeline-backpressure) | A | capacity gauge | M | yes | Backpressure is a blocked send and a gap of cap+1; the only proposal the verifier accepted unchanged. |
| 31 | [Serve Timeout Race: First-Wins Response Under a Deadline](#31-serve-timeout-race) | A | goroutine lanes | M | yes | A compact lane timeline that proves the player: the deadline fires, the handler keeps running, the result slot decides the leak. |
| 6 | [Fan-Out, Fan-In: Concurrent Thumbnail Generation](#06-fan-out-fan-in) | B | goroutine lanes | M | no | Ten sequential 150 ms calls versus ten stacked bars; the canonical fan-out shape has no README diagram. |
| 8 | [Pipeline: Multi-Stage Number Processing](#08-pipeline) | B | pipeline graph | M | no | Pipeline stages as rows; the share of time and the guard asymmetry become visible. Fix the solution doc first. |
| 13 | [Channel of Channels (Bridge Pattern): Merging Dynamic Log Shards](#13-channel-of-channels) | B | lane board | M | no | Head-of-line blocking is a schedule, not a value; a block-state board shows the hub stuck on one shard. |
| 19 | [Actor Model: A Bank Account with No Locks](#19-actor-model) | B | goroutine lanes | M | yes | The browser passes the scaffold, so the lesson is why -race matters; show the lost update a scripted local run finds. |
| 21 | [Dining Philosophers: Deadlock Avoidance](#21-dining-philosophers) | B | lock and waiters | M | yes | The wait-for cycle: five holders, five waiting edges, a closed ring; one reversed edge breaks it. |
| 22 | [Circuit Breaker: Protecting a Flaky Payment Gateway](#22-circuit-breaker) | B | state machine | M | yes | A state machine with a single trial slot; lock scope decides whether the gateway is called once or twice. |
| 27 | [Heartbeats: Detecting a Stalled Worker Before It's Too Late](#27-heartbeats) | B | timeline | M | yes | A heartbeat resets the deadline; no single flat timeout satisfies both bounds. The bar is the mechanism. |
| 28 | [Replicated Requests: Racing Redundant Calls for Lower Tail Latency](#28-replicated-requests) | B | goroutine lanes | M | yes | Returning does not cancel: the caller lane ends while replica lanes keep running; wasted replica-ms are counted. |
| 29 | [Healing Unhealthy Goroutines: A Steward That Restarts a Wedged Ward](#29-healing-goroutines) | B | goroutine lanes | M | no | A wedged ward and a steward that restarts it; the old generation keeps pulsing below the new one. |
| 0 | [Limit your Crawler](visualisation-catalog.md#00-limit-crawler) | C | goroutine lanes | M | yes | The first exercise a visitor opens; the shared throttle gate and the 5 ms to 13 s cost are visible, but the README already draws the shape. |
| 1 | [Producer-Consumer](visualisation-catalog.md#01-producer-consumer) | C | goroutine lanes | M | yes | Producer and consumer overlap on an unbuffered channel; useful, but the 320 ms EOF read and the buffering lesson need care. |
| 2 | [Race in an LRU Cache](visualisation-catalog.md#02-race-in-cache) | C | cache grid | M | yes | The hit path writes under a read lock; a recency strip shows the lost update, but the browser already prints loud numbers. |
| 7 | [Or-Done Channel: Stopping a Monitoring Feed Cleanly](visualisation-catalog.md#07-or-done-channel) | C | goroutine lanes | M | yes | The done channel stops the feed; a lane shows the leak, but the README diagram carries the shape. |
| 10 | [Semaphore: Bounding Parallelism Against a Rate-Limited API](visualisation-catalog.md#10-semaphore) | C | goroutine lanes | M | yes | Permit cells show the high-water mark; under GOMAXPROCS=1 the accepted order is surprising, so the script must be honest. |
| 11 | [Worker Pool: Batch Job Processor with Partial Failures](visualisation-catalog.md#11-worker-pool) | C | goroutine lanes | M | yes | A worker pool with partial failures; the fan-in ledger is useful, but 60 lanes do not fit 216 px. |
| 14b | [Tee Channel, Independent Closing: Racing a Fast Consumer Past a Silent One](visualisation-catalog.md#14b-tee-channel-independent-close) | C | goroutine lanes | M | yes | The slow-consumer tee is the hard case; build it with 14 only if the tee family earns a scene. |
| 16b | [errgroup.WithContext: Cancel-on-First-Error](visualisation-catalog.md#16b-errgroup-withcontext) | C | goroutine lanes | M | yes | Cancel-on-first-error; the context tree and the cancelled siblings are visible, but 16 already names the mechanism. |
| 24 | [Priority Worker Pool: Weighted Scheduling](visualisation-catalog.md#24-priority-worker-pool) | C | heap / queue | M | yes | The heap order and lost wake-up are real; heap ties are unordered, so the script must not invent a pop order. |
| 30 | [Livelock & Starvation: Two Failure Modes Beyond Deadlock](visualisation-catalog.md#30-livelock-starvation) | C | goroutine lanes | L | no | Livelock and starvation are schedules over time; L effort, no README diagram, and the prose already states both fixes. |
| 32 | [Racing a Fan-Out Against a Deadline](visualisation-catalog.md#32-fanout-deadline-race) | C | goroutine lanes | M | yes | Fan-out against a deadline; the orphan lanes are the lesson, but the test already prints the 100 versus 500 ms gap. |
| 33 | [Load Balancer: Self-Scheduling Workers That Report Their Own Load](visualisation-catalog.md#33-load-balancer) | C | goroutine lanes | M | yes | A load balancer's self-scheduling heap; the README's blocking claim is wrong, so fix the doc before animating. |
| 33b | [Non-Blocking Dispatch: A Load Balancer That Can't Depend on a Buffer](visualisation-catalog.md#33b-load-balancer-nonblocking-dispatch) | C | goroutine lanes | M | yes | Two gates and a nil-channel select; subtle, but the scaffold's shape must be scripted exactly. |
| 35 | [Your Own singleflight: Deduping In-Flight Duplicate Calls](visualisation-catalog.md#35-singleflight) | C | goroutine lanes | M | yes | singleflight dedupes in-flight calls; the solution doc already gives the full chronology, so the visual delta is small. |
| 36 | [Batch Collector: A Reusable Batcher With a Deadline and a Real Shutdown](visualisation-catalog.md#36-batch-collector) | C | capacity gauge | L | yes | The extreme batcher: the stale-timer guard and the exactly-once latch are worth seeing, but it is L effort. |
| 37 | [Safe Pool Shutdown: Closing a Multi-Producer Job Queue Without Panicking](visualisation-catalog.md#37-safe-pool-shutdown) | C | goroutine lanes | L | yes | Closing a multi-producer queue safely; the send parked on an unbuffered channel is the fact, but the fix is narrow. |
| 3 | [Limit Service Time for Free-tier Users](visualisation-catalog.md#03-limit-service-time) | D | lock and waiters | M | yes | Mechanical context and mutex substitution; the README states the orphaned process and the test states the double spend. |
| 5 | [Clean Inactive Sessions to Prevent Memory Overflow](visualisation-catalog.md#05-session-cleaner) | D | cache grid | M | yes | Every scene but the symptom is a counterfactual; the orphaned timer is solution-side and already bolded. |
| 9 | [Context Cancellation & Propagation](visualisation-catalog.md#09-context-cancellation) | D | timeline | S | no | Easy; the README states 200 < 300 and the test prints elapsed. Build the lane primitive at 31 or 32 instead. |
| 12 | [Pub-Sub: In-Memory Event Bus](visualisation-catalog.md#12-pub-sub) | D | goroutine lanes | M | no | The solution doc already names the mutex spread; the waiter picture is one static frame. |
| 14 | [Tee Channel: Duplicating a Sensor Stream](visualisation-catalog.md#14-tee-channel) | D | goroutine lanes | M | no | The README states the alias bug verbatim; 14b covers the only depth worth animating. |
| 15 | [Or-Channel Combinator: Combining Shutdown Triggers](visualisation-catalog.md#15-or-channel-combinator) | D | goroutine lanes | M | yes | Four scenes restate the README's four bullets; a two-state toggle is not worth a player. |
| 16 | [Your Own errgroup: Concurrent Tasks with First-Error Capture](visualisation-catalog.md#16-errgroup-failfast) | D | goroutine lanes | M | no | The README and test name hwm=1; the race scene is hypothetical and misattributed. |
| 17 | [Future/Promise Pattern: Async, Memoized Computation](visualisation-catalog.md#17-future-promise) | D | goroutine lanes | M | no | The README names sync.OnceValue and the mutex map; the fix is the prose. |
| 20 | [Concurrent Map-Reduce: Parallel Word Count](visualisation-catalog.md#20-concurrent-map-reduce) | D | goroutine lanes | M | no | Only observable is 300 versus 30 ms; a table carries it. The trap scene would draw a hypothetical race. |
| 23 | [Sharded Concurrent Cache: Reducing Lock Contention](visualisation-catalog.md#23-sharded-cache) | D | lock and waiters | M | yes | Latency is printed; the fix is twelve lines; the collision fact is a caption. |
| 25 | [Graceful Multi-Stage Shutdown](visualisation-catalog.md#25-graceful-multistage-shutdown) | D | goroutine lanes | M | yes | A six-line fix; the README diagram and test message already name 0/20. |
| 26 | [Pipeline Error Handling: Result Values Instead of Aborting](visualisation-catalog.md#26-pipeline-error-handling) | D | pipeline graph | M | no | The README states both truncation walls; a ledger is a table. Draw the missing ASCII diagram. |
| 34 | [Concurrent Prime Sieve: A Growing Pipeline That Must Learn to Shut Down](visualisation-catalog.md#34-prime-sieve) | D | pipeline graph | M | yes | Easy; two ASCII diagrams exist and the browser prints the goroutine delta. |
| 38 | [Settle Once: CompareAndSwap Between a Timeout and a Completion](visualisation-catalog.md#38-settle-once) | D | goroutine lanes | M | yes | The scaffold comment gives CAS; the browser passes the race test. A caption, not an animation. |
| 39 | [Load Shedding: Reject Fast Instead of Blocking the Hot Path](visualisation-catalog.md#39-load-shedding) | D | capacity gauge | S | yes | Easy; the README gives select/default; the visual adds a millisecond stall. |

### 5.1 The build tier in full

Tier A and Tier B carry the full spec. Tier C and Tier D are decisions only; their designs, scenes, and verifier corrections are in [`visualisation-catalog.md`](visualisation-catalog.md).

Tier A contains one engineering choice: 31 is a `nice` proposal, not a top-ten teaching case. It is in the pilot because the verifier produced exact events, and it proves the lane renderer end to end. If the goal is teaching value only, swap it for 13 or 22.

### Tier A — build first (pilot)

<a id="04-graceful-sigint"></a>
#### 4 — Graceful SIGINT Killing
`Tier A` · **high** · goroutine lanes · family `lanes` · effort M · README diagram: yes

**Pattern.** Signal handling: signal.Notify on a buffered channel + select between "graceful stop finished" and "next SIGINT forces exit", with the blocking Stop() moved onto its own goroutine.

**Core idea.** A call that may never return must not run on the goroutine that is still supposed to listen. Graceful shutdown is a select race between "the stop finished" and "the user gave up", not a wait for the stop to finish.

**What prose and tests cannot show.** The blocking is invisible in the source. Calling proc.Stop() directly on main looks correct, and TestFirstSigintTriesGracefulStopWithoutExiting cannot tell it apart from the right answer, because the mock's Stop() never returns either way. Only the second Ctrl-C exposes it: main is parked inside Stop(), the buffered channel already holds the second signal, and nobody reads it. The scaffold hides a second thing: with no signal.Notify registered, the OS default disposition kills the process on the first Ctrl-C, so proc.Stop() is never reached at all. Prose states both facts; neither is visible as time, parking or a queued unread signal.

**Design.** A narrow stage with a vertical time axis and three stacked swimlanes: main, proc.Run, proc.Stop. Beside them a signal mailbox with two slots, and a process lamp that stays lit while the program lives. The Run lane prints a dot every second, forever. On the first Ctrl-C in the scaffold, the signal hits the process but no listener exists, the lamp goes dark at once, and the Stop lane never appears. In the fixed variant the Stop lane appears and keeps printing dots while the main lane parks at a select gate with two doors; the second Ctrl-C drops a coin into the mailbox, the right door opens, and every lane is cut at the same instant the lamp goes dark.

**Scenes.**
1. **Scaffold: one Ctrl-C, no graceful stop** — Only the main lane and the Run lane exist. Dots tick once per second. A SIGINT marker travels from the OS to the process (never to a channel, because signal.Notify was never called). The process lamp goes dark immediately, mid-dot. The Stop lane never spawns, and the text "Stopping process.." never appears. This is the default, spoiler-free scene.
2. **The trap: Stop() on the main goroutine** — The fix with one line removed: main calls proc.Stop() directly. First Ctrl-C parks main inside Stop's infinite dot loop. Second Ctrl-C lands in the buffered channel and stays there as a filled slot with nothing draining it. The process lamp stays lit forever. This is the counterexample that the first test cannot catch.
3. **Fixed: first Ctrl-C starts a graceful stop** — A third lane (Stop) spawns and blocks in its Sleep loop, printing dots that never end. Main parks at a select gate with two doors: stopped (still shut) and sigChan (open, waiting). The process lamp stays lit and the test's expected "Stopping process.." line appears.
4. **Fixed: second Ctrl-C forces exit** — A second coin drops into the mailbox, the sigChan door opens, os.Exit(1) cuts all three lanes at once while the Stop lane is mid-dot. Optional branch: if Stop() is allowed to return and close(stopped), the left door opens instead and main exits through the graceful path.

**Controls.** Send first Ctrl-C (button and keyboard shortcut); Send second Ctrl-C; Play / Pause / Step / Restart, all keyboard reachable and never hover-only; Variant selector: scaffold | synchronous Stop | fixed (fixed variants behind the same spoiler gate wording as the Solution tab); Let Stop() finish (toggle) to show the other select branch, close(stopped); Signal channel capacity 1 vs 2, to show the second signal queued (and what a capacity of 1 costs).

**Annotations.** SIGINT delivered by the OS; no signal.Notify registered -> OS default disposition; signal.Notify(sigChan, os.Interrupt); buffer slot (cap 2); main parked in select; case <-stopped (graceful path); case <-sigChan (forced exit); Stop goroutine blocked in time.Sleep; this mock never returns; close(stopped); os.Exit(1) runs no deferred functions; signal queued, nobody listening; process lamp: alive / exited.

**Data model.** Entities: goroutines {id: main|run|stop, state: runnable | blocked_in_sleep | parked_in_select | exited}; channel sigChan {capacity 1-2, queue of pending os.Signal}; channel stopped {open|closed}; process {alive|exited(code)}; os {default_disposition|notify_registered}. Events, each with logical tick t, actor and kind: notify_registered, signal_sent {path: channel|default_disposition}, signal_recv, spawn(goroutine), block(sleep), park(select, armed cases), case_fire(case name), close(stopped), exit(code), kill_all. Each variant is a fixed, scripted event list; the renderer advances ticks, never wall clock, so Step is deterministic. Required terminal states: scaffold = exited by signal with stop lane never spawned; synchronous Stop = alive with one unread signal; fixed = alive after first signal, exited after second.

**Code anchors.**
- 04-graceful-sigint/main.go:21 — proc.Run() called directly, no signal handling
- 04-graceful-sigint/mockprocess.go:29-32 — Run() loops forever on dot + time.Sleep(1s)
- 04-graceful-sigint/mockprocess.go:37-48 — Stop() also loops forever; line 35-36 states it will not succeed by design
- solutions/04-graceful-sigint.md:73,78,79,82,88-92,96-102 — go proc.Run(), make(chan os.Signal, 2), signal.Notify, <-sigChan, go func(){proc.Stop(); close(stopped)}(), and the select that ends in os.Exit(1)
- solutions/04-graceful-sigint.md:55-57 — the prose that names the key trick
- 04-graceful-sigint/check_test.go — TestFirstSigintTriesGracefulStopWithoutExiting and TestSecondSigintForcesPromptExit; the comment on the first says a synchronous Stop() is indistinguishable until the second signal

**Verifier corrections — read before building.**
- Scaffold lane model is wrong. 04-graceful-sigint/main.go:21 calls proc.Run() on main, so the scaffold has one goroutine. The proposal draws a separate 'main lane' and 'Run lane'. That hides the fix's first move, go proc.Run() (solutions/04-graceful-sigint.md:73). Scene 1 must show one main lane executing Run. The Run lane starts only in the fixed variant.
- The trap is not 'the fix with one line removed'. The fix adds a goroutine, a stopped channel and a select (solutions/04-graceful-sigint.md:88-102). The trap is a different shape: <-sigChan; proc.Stop(). Name that shape in the scene, because a one-line-diff story is false.
- 'Let Stop() finish' is counterfactual. mockprocess.go:35-36 says Stop will not succeed, and its loop at mockprocess.go:45-48 never returns. A live toggle teaches a model that the mock deliberately denies. Render the stopped door as permanently shut. Annotate the graceful path as hypothetical at most, and keep it out of the default controls.
- The capacity 1 vs 2 control can teach a false rule. Main drains the first signal at solutions/04-graceful-sigint.md:82. After that, a cap-1 channel still holds the second signal. A drop happens only when two signals arrive before main reads. Drop the control, or script a rapid double Ctrl-C scene and explain it. The solution doc itself says 'size >= 1' at solutions/04-graceful-sigint.md:75-77.
- The shared annotation inventory leaks fix symbols into the default scene: signal.Notify, cap 2, close(stopped), os.Exit(1) and case <-stopped. spoiler_safe is honest only if every scene has an annotation allow-list, and the variant selector sits behind the same 'Show the solution' gate as web/src/components/DocPane.tsx:55-68.
- 'Nobody listening' is inaccurate for the trap. signal.Notify is registered, and the signal is queued in sigChan. No goroutine reads it. Say 'queued in sigChan, no receiver'. Otherwise learners blame Notify instead of the blocking Stop call.
- Lazy loading is under-specified. A runtime template import() is not reliably bundled by Vite. A map of 43 eager imports defeats laziness. Use a sparse registry { id: () => import('./visualisations/<id>.tsx') } or Vite's import.meta.glob. Both need no new dependency. The generator needs no change, because scripts are app code, not git HEAD data.
- The router change touches more than router.ts. Extend Route.tab, parseRoute and routePath in web/src/router.ts. Update DocPane Props.tab, ExerciseView Props.tab and App.tsx route.tab. Today parseRoute maps any unknown segment to 'problem' (web/src/router.ts:10-11), so /<id>/visualisation will silently show the problem tab unless it is added. Hide the tab when the registry has no script, and fall back to problem for that URL.
- The 320px layout is under-specified and partly contradictory. At <=900px the doc body has 16px side padding (web/src/styles.css:1029-1030), so usable width is about 288px. 'Lanes stack vertically with time flowing down' does not describe the lane-per-goroutine time axis it replaces. Choose one grid: time rows by three actor columns, or a vertical time spine with three narrow columns. Move the lamp and mailbox to a compact header row. Keep secondary experiments out of the default layout.
- Web-only is correct and forced. tools/check/lint.go:155 rejects any file in an exercise folder that is not README.md or .go, and the clone has no viewer. State web-only in the design, and label the tab a model, not a trace. The clone keeps the README diagram and the solution doc.
- The hand-written script will drift. Hard-coded mock text such as 'Stopping process..' and the 1s cadence can change. Add a unit test over each variant's required terminal state: scaffold dead, trap alive with one queued signal, fixed dead after the second signal. Add a comment tying each event to mockprocess.go and the solution doc. No new dependency is needed.
- The trap scene should show the test outcomes, not only the program state. Annotate 'TestFirstSigintTriesGracefulStopWithoutExiting passes; TestSecondSigintForcesPromptExit fails after 5s'. That is the link between the visual model and 04-graceful-sigint/check_test.go, and it is the sharpest statement of the blind spot.

**Corrected design (use where it conflicts with the design above).**

Placement: a third tab, present only when a registry has a script for that exercise id. Do not put it in the Solution tab: the default scene is the scaffold's symptom, so the spoiler gate would hide the exercise's main value. An inline section under the Problem README is the fallback if router churn is unwanted, but the tab is cleaner and gives the animation room. Hide the tab when no script exists; /<id>/visualisation falls back to the problem tab.

Modes: web only. The clone keeps README.md's ASCII diagram (04-graceful-sigint/README.md:8-16) and solutions/04-graceful-sigint.md. tools/check/lint.go:155 forbids extra files in 04-graceful-sigint/, and the clone has no viewer. Label the tab 'a model, not a trace'.

Scenes, with the lane model corrected:
1. Scaffold, default and spoiler-free: one lane, main, inside Run. Run prints 'Process running..' and a dot each logical second. An OS SIGINT marker ends the process immediately. The lamp goes dark mid-dot. No Stop lane. Annotate that TestFirstSigintTriesGracefulStopWithoutExiting fails waiting for 'Stopping process'.
2. Trap, behind the reveal gate: two lanes, main and Run (spawned by go proc.Run()), plus the mailbox. The first signal makes main call proc.Stop() on its own lane. Main parks inside the never-ending Stop loop. The second signal fills a mailbox slot. No receiver. The lamp stays lit. 'Stopping process..' is visible. Label the slot 'queued in sigChan, no receiver'. Annotate that test 1 passes and test 2 fails after 5s.
3. Fixed, first signal, behind the gate: three lanes, main, Run and Stop. Main parks at the select. The stopped door stays shut because this mock's Stop never returns. The sigChan door waits. The lamp stays lit.
4. Fixed, second signal: the second signal opens the sigChan door. os.Exit(1) cuts all lanes at once. The lamp goes dark. Annotate that os.Exit runs no deferred functions. Annotate the stopped door as 'if Stop returned, close(stopped) would open this door' as a hypothetical only.
5. Optional advanced scene: rapid double Ctrl-C with cap 1 and cap 2. Show the drop only when both signals arrive before main reads, and explain why cap 1 still works in the normal sequence.

Controls: Ctrl-C button; Play, Pause, Step and Restart as native buttons with visible focus and no hover requirement. Autoplay is off under prefers-reduced-motion; Step is the static path. The variant selector is behind the same 'Show the solution' gate as DocPane. Keep the default layout to the signal button and the transport controls. Move the capacity and hypothetical-stop experiments behind an 'Advanced' expander.

Layout: a compact header row with the process lamp and the two-slot mailbox, then one time grid. At wide widths use three actor columns over a time axis. At <=900px use a vertical time spine with three narrow columns labelled main, run and stop, or time rows by actor columns. Verify at about 288px usable width, in light and dark, with --fg, --fg-muted, --border, --bg-sunken, --accent and --pass.

Implementation: React plus SVG/CSS only; no new dependency. Put scripts in web/src/visualisations/. Lazy-load with a sparse registry mapping id to () => import('./visualisations/<id>.tsx'), or Vite's import.meta.glob('./visualisations/*.tsx'). Wrap in Suspense. Each variant is a fixed event list with logical ticks. Add a per-scene annotation allow-list and states for goroutines, sigChan, stopped, the process and the OS disposition.

Router: Route.tab becomes 'problem' | 'solution' | 'visualisation'. parseRoute accepts 'visualisation' only when the registry has the id. routePath emits /<id>/visualisation. Update DocPane Props.tab, ExerciseView Props.tab and App.tsx. Hide the tab when no script exists.

**Verifier note.** Verified against git HEAD. The scaffold calls proc.Run() directly (04-graceful-sigint/main.go:21) and registers no signal handler, so the first SIGINT kills it through the OS default disposition. TestFirstSigintTriesGracefulStopWithoutExiting waits for 'Stopping process' and fails for the scaffold. The synchronous variant passes that first test and fails TestSecondSigintForcesPromptExit, because main is parked in Stop and the second signal sits in the buffered channel. That part of the analyst's analysis is correct.

The browser-unsupported claim is correct: web/src/generated/exercises.json:72 marks 04 unsupported because check_test.go imports os/exec. 04 is the only one of 43 exercises with that marker. web/package.json ships only marked, monaco-editor, react and react-dom, so the design needs no new dependency beyond React.

Verdict: I choose high, not must. The README already says 'waiting for it to finish is not an option' (04-graceful-sigint/README.md:29-30), and its ASCII diagram already shows the two-signal goal (04-graceful-sigint/README.md:8-16). The visualisation does not reveal new facts; it shows time order, parking and the unread signal. That is real value, and the browser's lack of dynamic feedback makes 04 the top priority, but it does not make the visualisation necessary.

Feasibility: with-changes. The core form fits a static site at about 288px with CSS variables, reduced motion and a Vite lazy import. The needed changes are the corrected scaffold lane model, the trap shape, the spoiler gate on variants, the capacity control, the counterfactual Stop toggle, and the concrete router and layout plan. The cited line numbers were checked: main.go:21, mockprocess.go:29-32, mockprocess.go:35-36 and 45-48, solutions/04-graceful-sigint.md:73, 78, 79, 82 and 88-102, generated/exercises.json:72, tools/check/lint.go:155, styles.css:1029-1030, router.ts:10-11, DocPane.tsx:55-68.

**Risks.**
- Two modes: this visualisation lives under web/src and web/tools/gen/main.go ships only .go, .md and go.mod from git HEAD, so it reaches the browser site only. The cloned repo keeps its README ASCII diagram and the solutions doc. Reaching both modes would need files inside 04-graceful-sigint/, which the layout rule (tools/check/lint.go:154) forbids; accept web-only and say so.
- The third tab is a spoiler backdoor unless the default scene is the scaffold and the fixed variants sit behind the same 'Show the solution' gate as the Solution tab. DocPane.tsx already gates the solution; reuse that pattern, do not invent a weaker one.
- The script is a hand-written model, not an observation of the real code. If MockProcess or the tests change, it goes stale silently. Tie each event to a named symbol (as in ties_to_code) and label the tab as a model.
- Do not generalise the mock: Stop() never returning is deliberately adversarial. If unlabelled, learners conclude that every Stop() hangs.
- 'The OS kills the process' is not a goroutine. Drawing it as a lane would teach a false model; render it as the process lamp going dark with a separate annotation.
- 320px: three side-by-side lanes will not fit. Stack lanes vertically, time flowing down, and verify in both themes using the CSS variables (--fg, --fg-muted, --border, --bg-sunken, --accent, --pass).
- Router and tab work applies to all 43 exercises even if only a few ship a script: router.ts parseRoute/routePath need /<id>/visualisation, DocPane gets a third anchor, and the tab must hide when no script exists for that id.
- Lazy loading: load each script with a dynamic import keyed by exercise id, so the one-JSON-per-exercise design keeps its cost. A static map of 43 imports defeats it.
- prefers-reduced-motion must disable autoplay; the Play/Step controls remain as the static path, and nothing may depend on hover.

**Why this tier.** The browser cannot run this exercise at all; the signal mailbox and the parked Stop are visible only as time.

<a id="18-bounded-pipeline-backpressure"></a>
#### 18 — Bounded Pipeline with Backpressure
`Tier A` · **high** · capacity gauge · family `gauge` · effort M · README diagram: yes

**Pattern.** Bounded pipeline with backpressure: a producer goroutine sends into a small, fixed-capacity channel, and a consumer goroutine ranges over it. Channel capacity is the flow-control valve. The scaffold instead appends every item to a growing slice, then consumes afterwards.

**Core idea.** Channel capacity is the backpressure control. Once the buffer plus the one item the consumer is holding is full, ch <- produce(i) blocks until the consumer drains a slot. So the producer can never run more than cap+1 items ahead, and that bound does not grow with itemCount.

**What prose and tests cannot show.** The naive version passes TestRunPipelineProcessesAllItems: it drops nothing and has no data race. The bug is invisible to a correctness check. The learner cannot see from the prose that in the scaffold produce and consume never overlap, that produce(19) fires while 0 items are consumed (gap 19), that the slice grows linearly, and that in the fix the producer physically blocks on a send and resumes the instant a receive frees a slot. The gap numbers 19 and 3 are abstract without a timeline, and so is the fact that the bound is cap+1 and not some function of itemCount.

**Design.** Two horizontal lanes with a buffer between them. Top lane is the producer, firing one produce(i) per step. Bottom lane is the consumer, holding one item at a time and dark for 50 ms per item. Between them, a queue drawn as slots. In scene 1 the queue has no cap: it is an open shelf, and items 0 through 19 land on it before the consumer moves once; a gap gauge under the shelf climbs to 19 and turns red, and a TestRunPipelineAppliesBackpressure badge flips to FAIL (maxGap 19 > 5). In scene 2 the shelf becomes three slots: two buffer cells and one labelled "in hand". When all slots are full the producer's arm turns dashed and grey with the label "send blocked"; the consumer finishes an item, takes the next, the arm snaps back on, and the gap meter never passes 3. A strip of events runs beneath both lanes and can be scrubbed.

**Scenes.**
1. **Scaffold: buffers the whole run** — Producer fires produce(0..19) in a burst into an open shelf with no cap while the consumer sits idle. Then the consumer drains one item per 50 ms while the shelf shrinks. The gap meter peaks at 19, memory counter reaches 20 items, and the test badges read ProcessesAllItems PASS, AppliesBackpressure FAIL. An annotation marks that append never blocks and that consume does not start until every produce finished.
2. **Bounded channel: the send blocks** — The shelf becomes three slots (cap 2 plus the item in the consumer's hand). The producer sends; when the slots are full its arm greys out with 'send blocked'. The consumer finishes an item, receives one from the buffer, and the blocked send completes at once. The gap meter stays at 3 or below, and AppliesBackpressure flips to PASS. This scene is behind the spoiler reveal.
3. **Buffer knob: gap = cap + 1** — The same run repeated at cap 0, 2, 4 and 5 with the peak gap recorded beside each: 1, 3, 5, 6. The gauge visibly tracks the knob, the last run crosses the maxAllowedGap = 5 line and fails, and the run duration stays at 20 x 50 ms at every cap, showing the buffer changes the gap, not throughput.

**Controls.** Play / Pause (Space); Step one event forward, to support prefers-reduced-motion (right arrow); Restart (R); Timeline scrubber over the event strip; Buffer size stepper 0 to 6, showing gap = size + 1 and the pass/fail line at 5; Consumer latency toggle 50 ms / 150 ms to show the gap bound does not depend on speed.

**Annotations.** append never blocks: the slice has no cap (scaffold); no overlap: consume(0) waits for produce(19); go func(): producer goroutine spawned; ch <- produce(i); send blocks: buffer full; receive frees a slot; the blocked send completes at once; in hand: the +1 in gap = cap + 1; close(ch): the range loop ends; gap = produce index - items fully consumed; maxGap 19 > 5: TestRunPipelineAppliesBackpressure fails; gap 1 at cap 0: unbuffered is the same design, one slot tighter.

**Data model.** Entities: producer (goroutine in fixed mode, plain loop in scaffold); consumer (main goroutine); buffer {kind: "slice" with no cap, or "channel" with cap N drawn as N cells plus one inHand cell}; item {id, state: pending | producing | queued | inHand | consuming | consumed, tProduce, tSend, tRecv, tConsumeStart, tConsumeEnd}; metrics {produced, consumed, queued, inHand, gap = produced - consumed, memory = queued + inHand, blocked}; per-run verdict {maxGap, threshold 5, pass}. Events on a logical millisecond clock: spawn(producer), produce(i), append(item), sendAttempt(i), block(reason: buffer-full), recv(item), unblock, consumeStart(item), consumeEnd(item), close, rangeEnd, exit, verdict. The timeline is a precomputed deterministic frame array; each frame carries {t, actor, event, and the derived state snapshot}. Consume costs a fixed 50 ms; produce is instantaneous. The renderer is a pure function of frame index, so pause, step and scrub need no animation engine, and reduced motion simply steps frames.

**Code anchors.**
- scaffold main.go RunPipeline: items := make([]T, 0, itemCount); append loop; range over the slice; no goroutine, no close
- solution: const boundedBufferSize = 2; ch := make(chan T, boundedBufferSize); go func(){ defer close(ch); for i { ch <- produce(i) } }(); for item := range ch { consume(item) }
- mockslowconsumer.go: ConsumeLatency = 50 * time.Millisecond, the dark consumer lane
- check_test.go TestRunPipelineAppliesBackpressure: gapAtProduce[i] = i - consumedSoFar, maxAllowedGap = 5, synctest fake clock
- solution doc tuning table: cap 0/2/3/4/5 gives max gap 1/3/4/5/6, the data behind the buffer-knob scene

**Verifier corrections — read before building.**
- Scene 2 is factually wrong when it says the producer blocks "when all slots are full". The producer blocks when the two channel cells are full (cap 2); the item in the consumer's hand is outside the channel. Draw 2 buffer cells plus a separate consumer cell, and label capacity as 2, not 3.
- Scene 1 is factually wrong when it says the scaffold has "no cap". The scaffold is make([]T, 0, itemCount) at 18-bounded-pipeline-backpressure/main.go:55, so its capacity is 20 for itemCount 20. The real contrast is "capacity = the whole run, so the bound scales with itemCount" versus "capacity = 2, so the bound is constant". The slice also allocates its capacity up front, so do not draw memory growing as items arrive.
- The rationale overstates the blind spot. The scaffold does fail a correctness check: TestRunPipelineAppliesBackpressure reports "max gap ... = 19, want <= 5" at check_test.go:107-112. I verified this in the web runner with node scripts/smoke-test.ts --only 18: the first test passes, the second fails. The symptom is invisible only to TestRunPipelineProcessesAllItems, not to every correctness check.
- The tab row will not fit at the real worst case. The doc pane can shrink to 260px at web/src/styles.css:506, not 320px. Three tabs plus the difficulty badge and the optional passed badge exceed 260px and also overflow 320px with the label "Visualise". Use a short label such as "Demo", hide the difficulty badge below a breakpoint, or let the row wrap, and test at 260px.
- The gap definition is easy to get wrong. Sample gap only when produce(i) is called, as gapAtProduce[i] = i - consumedSoFar at check_test.go:88; item i is not yet produced at that instant. If the renderer counts the in-flight item or samples at receive time, the gauge is off by one. Label the continuous gauge "produced minus fully consumed" and the badge "max gap at produce".
- Scene 3 is not gated in the proposal; only scene 2 is. Both fixed-version scenes must share the revealed state that gates the Solution tab at web/src/components/DocPane.tsx:17. Cut scene 3 and the consumer-latency toggle to a later version; the cap+1 table is already in solutions/18-bounded-pipeline-backpressure.md.
- At t=0 the scaffold's 20 instant produce calls collapse to one point on a millisecond axis. Use event-index frames, one frame per event, draw the consumer's 50ms waits as spans, and label the axis "logical time, not to scale". Otherwise the burst is unreadable at 260px.
- Do not bind Space and the arrow keys globally. Space scrolls .doc-body and activates a focused button. Use native buttons for play, pause, step and restart, and scope any shortcut handler to a focusable container with tabIndex=0 and preventDefault only while it has focus.
- Reduced motion needs a default, not only a step button. When matchMedia('(prefers-reduced-motion: reduce)') matches, start paused and disable CSS transitions. Keep the step button as the only way to advance until the user presses Play.
- The design has no screen-reader text equivalent. Add an aria-live="polite" line such as "produced 4, consumed 1, gap 3 of 5, send blocked" and role="meter" with aria-valuenow/min/max on the gauge. Keyboard access alone is not enough. The current event annotation must be visible, not a hover tooltip.
- Effort is L, not M. The work includes the frame engine, the renderer, two or three scenes, controls, accessibility, tests, a new route in web/src/router.ts:6/11/12, a new tab in DocPane.tsx:26-32, the prop union in ExerciseView.tsx:10, a lazy registry, and 260px CSS. Ship two scenes first; add the knob later.
- Hardcoded constants can drift silently. itemCount=20 and maxAllowedGap=5 are in check_test.go:79 and :107; cap=2 and ConsumeLatency=50ms are in mockslowconsumer.go:9 and the reference solution. Keep one visualConfig per exercise with a comment naming each source. The solution doc's table also gives cap 3 -> 4 and cap 6 -> 7; the scene's 0/2/4/5 subset is correct, and I measured 0..6 -> 1..7.
- Minor: the proposal says inline embedding would need generator support. It would not; tools/gen/main.go copies README text verbatim. The change would be in web/src/markdown.ts and web/src/components/Markdown.tsx. The tab is still the better choice, but the cost claim is wrong.

**Corrected design (use where it conflicts with the design above).**

Keep the third tab, but label it "Demo" at route /<id>/demo, hide it when the registry has no component, and share DocPane's revealed state for scenes 2 and 3. Render with DOM and CSS variables, not canvas: a producer lane; a channel block of exactly 2 cells with a "cap 2" label; a separate "consuming" cell on the consumer lane; a gap meter with role="meter"; and an event-index strip. At 260px stack vertically, keep the current event's annotation in a fixed caption, and hide the difficulty badge. Scene 1 labels the scaffold's buffer "capacity = 20 (the whole run)" and shows the produce burst as an event sequence, gap 19, first test PASS and second FAIL. Scene 2, behind the reveal, shows cap 2, the send blocked when the 2 cells are full, the receive that frees a cell, and gap <= 3. Make scene 3, the cap knob, and the latency toggle a later version. Precompute one frame per event with a config {itemCount: 20, cap: 2, maxAllowedGap: 5, latency: 50ms}, each with a source comment; sample the gap at produce. Use native buttons, start paused under reduced motion, add an aria-live status line, and lazy-load through a registry of React.lazy(() => import(...)). Document web-only in web/README.md. Effort L; build the two-scene version first. If the tab row cannot be made to fit at 260px, use a collapsed "Show the timeline" disclosure at the top of the Problem tab, rendered by DocPane outside Markdown, not only in the Solution tab.

**Verifier note.** Verified from git HEAD. The scaffold at 18-bounded-pipeline-backpressure/main.go:55 fills a slice of capacity 20 before the consumer runs; TestRunPipelineProcessesAllItems passes and TestRunPipelineAppliesBackpressure fails with max gap 19. I ran node scripts/smoke-test.ts --only 18 in web/ and got exactly that, so testing/synctest works in the browser runner and the visualisation is not the learner's only way to see the symptom. In a temp copy under Go 1.25.6 I measured max gap 1,2,3,4,5,6,7 for cap 0..6, and max gap 3 at cap 2 with consumer latency 10, 50 and 150ms, which confirms the scene-3 table and the latency claim. The exercise README already has before and after ASCII diagrams and the solution doc has the tuning table, so the visual's unique gain is time and the blocked moment; that makes "high" defensible but not "must". Scene 1 is spoiler-safe; scenes 2 and 3 are not and must be gated. Placement: a third tab, not inline, because the Problem tab is Markdown with no component directive and the Solution tab is gated; web only, because the clone learner keeps the README ASCII and the test output, and the layout lint at tools/check/lint.go:154 forbids new files in the exercise folder. Feasibility: no new dependency is needed; React.lazy, CSS variables and the existing Vercel catch-all rewrite cover it. The real feasibility work is the 260px tab row and the event-index timeline.

**Risks.**
- Spoiler leak: the fixed scene (goroutine + buffered channel) must sit behind the same reveal state as the Solution tab, or the third tab gives away the answer. Scene 1 must describe the symptom without naming the fix.
- Third-tab infrastructure: Route.tab is a two-value union today and DocPane renders two anchors. The tab needs a route such as /<id>/visualise, a conditional anchor, and a lazy import keyed by exercise id, hidden for the exercises that have no component. Do this once, not per exercise.
- 320 CSS px: producer lane, buffer gauge, consumer lane and timeline cannot sit side by side. Stack them vertically, keep labels to one short word, and never drop body text below 11.5 px.
- Fidelity: it is a scripted explainer, not a trace of the learner's code. Label it. Worse, a scene that measures the gap at receive time instead of at the produce instant will show a smaller, wrong gap than the test does; compute gap exactly as check_test.go does.
- The browser runner uses GOMAXPROCS=1, so goroutines switch only when one blocks. A scene that shows true parallelism would contradict what the learner sees in the console. Show interleaving only at the blocking points.
- Accessibility: blocked state must not rely on color alone. Use a dashed border plus the word 'blocked'. The step mode, not a slowed animation, is the reduced-motion answer.
- Hardcoded constants (20 items, cap 2, threshold 5) duplicate check_test.go and the solution doc. If the exercise changes they become silently false; keep one per-exercise config with a comment tying each number to its source.
- Both modes: there is no terminal equivalent and none should be built. New files inside the exercise folder are forbidden by the layout lint rule; the clone-mode learner keeps the ASCII diagram and the test's failure message. State web-only in web/README.md.

**Why this tier.** Backpressure is a blocked send and a gap of cap+1; the only proposal the verifier accepted unchanged.

<a id="31-serve-timeout-race"></a>
#### 31 — Serve Timeout Race: First-Wins Response Under a Deadline
`Tier A` · **nice** · goroutine lanes · family `lanes` · effort M · README diagram: yes

**Pattern.** First-wins race between an uncooperative handler and a context deadline: spawn the handler goroutine, send its result on a channel buffered to one, and `select` over that channel and `ctx.Done()`.

**Core idea.** A deadline can stop `Serve` from waiting; it cannot stop a handler that never receives `ctx`. The fix is a first-wins `select` between the handler's result and `ctx.Done()`, with the result channel buffered to exactly one so the losing send never blocks.

**What prose and tests cannot show.** The losing send. After `Serve` returns `ctx.Err()`, the handler goroutine still runs and then executes `resCh <- result{...}` with nobody receiving. With an unbuffered channel that send blocks forever, so the goroutine leaks even though `Serve` returned correctly. Nothing in the scaffold or the happy-path test shows this; the learner cannot see that "Serve returned" and "the handler finished" are different facts, nor that channel capacity decides whether the loser exits or hangs.

**Design.** Show a shared virtual clock (0-600 ms) with two goroutine lanes and one deadline lane. In the default scaffold scene, `Serve` calls `handler` inline: the caller lane is solid-blocked from 0 to 500 ms, the 100 ms deadline marks a tick that nobody watches, and `Serve` returns "too-late" at 500 ms with a nil error. Switch to the first-wins scene and `Serve` spawns a handler lane, opens a result channel with one slot, and parks in a `select`. At 100 ms the deadline lane fires; `Serve` returns `context.DeadlineExceeded` and its lane ends. The handler lane keeps running alone and at 500 ms drops its result into the empty slot and exits. Switch the channel to capacity 0 and the 500 ms send has nowhere to go: the handler lane stops at that point forever, and a leak badge appears beside it. A second reference line at 150 ms shows the test's budget, so the learner sees why returning at 100 ms passes and returning at 500 ms fails.

**Scenes.**
1. **Scaffold: the deadline nobody reads (default)** — Spoiler-safe. One lane. `Serve`'s frame calls `handler` directly, so the caller lane is blocked 0 to 500 ms. The 100 ms deadline fires on the deadline lane with no listener and no effect. The 150 ms test-budget marker is crossed while `Serve` is still blocked. `Serve` returns the handler's value at 500 ms with a nil error. Annotation: ctx accepted but never read.
2. **Handler wins the race** — Latency 20 ms, deadline 2 s. `Serve` spawns the handler lane and parks in `select`; the handler sends at 20 ms, the select takes the `resCh` case, and `Serve` returns the handler's value and its own error (when WithError is on). `defer cancel()` releases the timer. This is the happy path that passes even on the scaffold.
3. **Deadline wins; the handler keeps running** — Latency 500 ms, deadline 100 ms, result channel capacity 1. At 100 ms `ctx.Done()` fires, the select takes that case, `Serve` returns ('', DeadlineExceeded) and its lane ends. The handler lane continues alone to 500 ms, sends into the free slot, and exits; RanToCompletion is true and no goroutine is left. Callout: Serve stopped waiting, it did not stop the handler.
4. **Unbuffered send leaks** — Same race, capacity 0. At 500 ms the handler's send finds no receiver and blocks. Nothing will ever receive. The handler lane stays alive past the end of the timeline with a blocked-send annotation and a leak counter; the goroutine never exits. This is the wrong fix that the one-slot buffer prevents.

**Controls.** Play / Pause: run or hold the virtual clock (keyboard Space).; Step: advance exactly one event (keyboard Right Arrow), so the reduced-motion and keyboard-only paths teach the same lesson.; Restart: reset to t=0 (keyboard R).; Scene selector: scaffold symptom, handler wins, deadline wins, unbuffered leak (keyboard arrow keys).; Deadline preset: 100 ms (the demo and test) or 2 s (the happy path).; Handler latency preset: 20 ms, 50 ms, 500 ms, 2 s.; Result channel capacity: 0 (unbuffered) or 1 (buffered) - the switch that turns the late send into a leak.; Handler returns an error: on or off, to show value and error propagated together on the winning path..

**Annotations.** handler() called inline - Serve cannot observe ctx; ctx accepted, never selected; deadline fires: context.DeadlineExceeded; test budget: return before 150 ms; go func(): the handler now runs unattended; select: two cases, one winner; resCh <- result: send blocks with no receiver; cap 1 slot absorbs the late send; handler keeps running - no ctx, no cancellation; return "", ctx.Err(); handler completed anyway (RanToCompletion); goroutine leak: blocked send never completes; defer cancel(): the timer is released; Serve returned; the handler did not stop.

**Data model.** Entities: caller (goroutine), serveFrame (Serve activation), handlerGoroutine, ctxTimer{deadline}, resCh{capacity: 0|1, buffer[]}, selectNode{caseRes, caseDone}. Lanes: serve, handler, deadline. Clock: virtual milliseconds, default 0-600. Event kinds: arm(timer,D), call(fn) [inline], spawn(handler), sleep(latency), fire(ctx,DeadlineExceeded), select(case), send(ch,value,err), recv(ch), block(lane,reason), unblock(lane), return(value,err), complete(handler), exit(goroutine), cancel(timer). Event shape: {t, lane, kind, label, payload}; the renderer sorts by t, then list index, and derives lane state (idle | run | blocked | done), buffer state (empty | filled(v)), and leak count. S1 scaffold: [0 serve call(handler)] [0 serve block('inside handler')] [100 deadline fire; marker only, no lane reaction] [500 handler complete] [500 serve return('too-late', nil)] [500 serve exit]. S2 handler wins: [0 serve spawn(handler)] [0 serve select(wait)] [0 handler run] [20 handler complete] [20 handler send(resCh)] [20 serve select(caseRes)] [20 serve return('payload', err)] [20 serve exit] [20 handler exit] [20 serve cancel(timer)]. S3 deadline wins, cap 1: [0 serve spawn] [0 serve select(wait)] [0 handler run] [100 deadline fire] [100 serve select(caseDone)] [100 serve return('', DeadlineExceeded)] [100 serve exit] [500 handler complete] [500 handler send(resCh)] [500 buffer filled] [500 handler exit]; the buffer stays filled and unread. S4 unbuffered, cap 0: [0 serve spawn] [0 serve select(wait)] [0 handler run] [100 deadline fire] [100 serve select(caseDone)] [100 serve return('', DeadlineExceeded)] [100 serve exit] [500 handler complete] [500 handler send(resCh)] [500 handler block('send: no receiver')] [end]; the handler never exits and leak=1. Invariants: only one select case fires per run; timestamps are non-decreasing and ties follow list order; the serve lane ends at its return; when the deadline wins, the handler lane must continue past the return.

**Code anchors.**
- 31-serve-timeout-race/main.go:46 - `return handler()`: the scaffold's inline call that scene 1 draws as a blocked caller lane.
- 31-serve-timeout-race/main.go:50 and :56 - `context.WithTimeout(..., 100*time.Millisecond)` and `time.Sleep(500 * time.Millisecond)`: the default scene timings.
- solutions/31-serve-timeout-race.md, Approach 1 fence line 6 (1-based inside the block) - `resCh := make(chan result, 1)`: the one-slot buffer that decides whether scene 3 exits or scene 4 leaks.
- solutions/31-serve-timeout-race.md, same fence lines 14 and 16 - `case res := <-resCh` and `case <-ctx.Done()`: the two racing cases drawn at the select node.
- 31-serve-timeout-race/check_test.go, TestServeRespectsDeadlineWhenHandlerIgnoresCtx - `budget = 150 * time.Millisecond` and `h.RanToCompletion()`: the return-before-150 ms assertion and the handler-must-still-finish assertion, drawn as the budget line and the completion badge.
- 31-serve-timeout-race/mockhandler.go, Handler and RanToCompletion - the latency sleep and the completion flag that scene 3 reads as 'completed anyway'.
- 31-serve-timeout-race/README.md - the today/goal ASCII fence: the visual is the web-mode form of that diagram, so the two must say the same thing.

**Verifier corrections — read before building.**
- Spoiler scope is wrong. Scene 2 ('Handler wins') already shows `go func` plus `select`, which is the shape of the fix, yet the proposal gates only scenes 3 and 4 (its own risk list says so). An ungated third tab therefore leaks the answer at scene 2.
- The claimed blind spot is post-spoiler only. A losing send exists only in the fixed version, so the pre-solve view is scene 1, which README.md:16-29 already draws (inline handler, ctx never read). After the reveal, solutions/31-serve-timeout-race.md:89-98 already explains the buffer in full. The unique gain is showing the send block, and that is one fact.
- The verdict overstates value against its own reason ('not essential', README already draws it, the test names the failure). Exercise 31 is rated medium in README.md:50. Nothing in the proposal needs 'high'.
- The cap-0 claim is false as written. `core_idea` says 'channel capacity decides whether the loser exits or hangs'. A sender that selects against ctx.Done() also exits with cap 0: `select { case resCh <- result{v, err}: case <-ctx.Done(): }`. Scene 4 must read 'bare send on an unbuffered channel', or the figure must show this second correct shape.
- The solution doc's own justification is shaky for the same reason. solutions/31-serve-timeout-race.md:106-111 says the sender 'has no ctx to select against', but the wrapper goroutine does have ctx in scope. Do not restate that claim in the visual.
- Cancel is attributed to the wrong lane and the wrong time. `defer cancel()` lives in the test (check_test.go:57) and in main (main.go:51), never in Serve. S2's '[20 serve cancel(timer)]' gives Serve an action it does not do, and it lists cancel after `serve exit`; a deferred call runs when the function returns, before the caller resumes.
- In the deadline-wins scenes the timer already fired at 100 ms, so the test's deferred cancel at about 600 ms is not what stops it. The annotation 'defer cancel(): the timer is released' holds only in the happy path (2 s deadline), where the test returns at 50 ms.
- Scene 2 uses 20 ms, which matches no test. The happy path is 50 ms with a 2 s deadline (check_test.go:26-28); the error path is 10 ms with a 2 s deadline (check_test.go:101-103). This breaks the proposal's own rule that timings must match the test.
- S1 shows the value 'too-late', which is the test fixture (check_test.go:54). The scaffold's own main() returns 'finally done' (main.go:55-58). Caption the figure 'as the test measures it', or a learner who ran the demo sees a contradiction.
- S4 ends at 500 ms, but the test's own time.Sleep(500ms) (check_test.go:85) ends at about 600 ms, and then synctest panics because the blocked goroutine never exits. Run the deadline scenes to 600 ms and show the panic, or the figure disagrees with the runner output.
- The 150 ms line means 'fail if elapsed >= 150 ms' (check_test.go:71-77). A marker labelled only 'budget' can read as 'returning at 150 ms is fine', which is the opposite of the assertion.
- 320 px is tight for three side-by-side lanes. The doc pane can shrink to 260 px (styles.css:506), which leaves about 100 px per lane. A scaled SVG drops text below legibility. Stack goroutine rows vertically and keep one horizontal time axis.
- A third tab is four-file route surgery: the union '"problem" | "solution"' appears in router.ts:6, ExerciseView.tsx:10, and DocPane.tsx:11, and parseRoute falls back to problem for unknown segments (router.ts:12). Placement inside the two existing tabs avoids it.
- The scaffold is 3 lines (main.go:45-47), not ten. One scene plus a shared renderer is effort S or M; the exercise alone does not justify M.
- Reduced motion is only half covered. The CSS block at styles.css:1067 removes transitions; the component also needs JS matchMedia to start paused in step mode and to react when the setting changes.
- import.meta.glob is available (tsconfig.json:16 lists vite/client), but the app has no lazy component today (no React.lazy, Suspense, or import.meta.glob under src/). A static id-to-import registry with React.lazy is simpler and type-safe for one exercise.
- Clone mode is correct but needs precise wording. The visual is web-only as a rendering surface: GitHub cannot show it, and lint.go:154 plus gen/main.go:485 keep scene files out of the exercise folder and out of the HEAD JSON. A cloned checkout can still run web/ locally, so there is one implementation, not two.

**Corrected design (use where it conflicts with the design above).**

PLACEMENT: do not add a third tab. Split the figure by spoiler status and mount both halves inside DocPane (web/src/components/DocPane.tsx:53-69).

1. Problem tab, after the README Markdown (below the ASCII diagram): one figure titled "The scaffold, as the test measures it". It shows scene 1 only: the inline handler fills the 0-500 ms span, the 100 ms deadline tick has no listener, and the 150 ms fail line is crossed. It needs no gate because it reveals no fix. Keep the README diagram; the figure does not replace it.
2. Solution tab, inside the existing `revealed` branch, after the solution Markdown: the mechanism figure with scenes 2-4. The existing `revealed` state is the only spoiler gate. Do not build a second one.

This keeps the route union at problem|solution and touches one file. If the owner still wants a third tab, the whole body must sit behind the same gate as Solution; before the reveal it would hold only scene 1 and be nearly empty, which is why the two existing tabs are better.

MODES: web-only. State it precisely: the figure lives under web/src and ships on the site. A cloned checkout can run `cd web && npm run dev` and see the same figure. GitHub's README view cannot show it. The layout rule (tools/check/lint.go:154) and the generator's extension filter (web/tools/gen/main.go:485) make an exercise-folder file or a JSON payload impossible. Keep the README ASCII diagram as the clone-mode statement and make the two agree.

FORM: stack goroutine rows vertically (Serve, handler, deadline) with one horizontal 0-600 ms axis. Draw the result channel as a one-slot box on the handler row, and add a test row for the 150 ms check and the 600 ms end. This fits 260-320 px; side-by-side lanes do not.

LOADING: a typed registry `{ "31-serve-timeout-race": () => import("./visualisations/serveTimeout.tsx") }` behind React.lazy and Suspense. Do not use import.meta.glob for one entry. No new dependency; SVG plus the existing CSS variables (--accent, --fg-muted, --bg-sunken, --border).

SCRIPT FIXES: label scene 1 with the test's fixture value; use 50 ms / 2 s for the happy path and 10 ms / 2 s for the error path; put cancel on the caller/test row and before exit, and show it only in the happy path; title scene 4 "bare send on an unbuffered channel" and add the ctx-aware send as the alternative that also exits; run the deadline scenes to 600 ms and show the synctest deadlock marker; label the 150 ms line "fail if elapsed >= 150 ms"; keep the deadline (100 ms) and handler completion (500 ms) on distinct timestamps so the select tie-break never looks random.

CONTROLS: real buttons; a labelled `<select>` for scenes (keyboard-native); Space, Right Arrow, and R only while focus is inside the figure; JS matchMedia("(prefers-reduced-motion: reduce)") starts the figure paused in step mode and disables autoplay.

EFFORT: S/M for one scene plus a shared renderer. The renderer becomes worth its cost only when exercise 32 reuses it.

**Verifier note.** I read the exercise and web files from git HEAD and from the working tree for non-exercise files. The scaffold does fail as described: Serve is exactly `return handler()` (main.go:45-47), the key test fails at check_test.go:63-66 because the error is nil after 500 ms, and the happy path passes on the scaffold (check_test.go:24-39). The analyst's file:line ties are accurate: main.go:46, :50, :56; the solution fence `{6,14,16}` maps to resCh cap 1, `case res <-resCh`, and `case <-ctx.Done()`; the test budget is at check_test.go:71 and RanToCompletion at :87; lint.go:154, gen/main.go:485, styles.css:540, and DocPane.tsx:26-32 all match. The site constraints are as stated: no race detector, GOMAXPROCS=1, and exercise 31 has no unsupported flag in web/src/generated/exercises.json, so the runner intends to run its synctest tests; the smoke gate requires a real `--- FAIL` assertion (scripts/smoke-test.ts:108-110), which the scaffold produces on its first check.

My refutation has three parts. (1) The design is not spoiler-safe as scoped: scene 2 shows the fix. (2) The unique lesson (a blocked send) exists only inside the fixed version, so it is post-spoiler and competes with solution prose; the pre-solve scene duplicates the README diagram. That downgrades the verdict from high to nice. (3) The "capacity decides" claim is wrong: a send that selects on ctx.Done() exits with cap 0. The proposed third tab also duplicates the existing spoiler gate, so I recommend mounting the symptom scene in the Problem tab and the mechanism scenes in the revealed Solution branch.

Feasible with changes: no new dependency is needed, the 260-320 px width works with vertical rows, lit/dark works through the existing CSS variables, reduced motion needs a JS matchMedia hook (the CSS block at styles.css:1067 only removes transitions), and lazy loading needs React.lazy plus a small registry because no lazy component exists in src today. The clone-versus-web question resolves to one implementation under web/, visible from a clone via npm run dev and invisible on GitHub, because lint.go:154 and gen/main.go:485 forbid any other location.

No files were written.

**Risks.**
- Web-only, by construction. The layout rule at tools/check/lint.go:154 allows only README.md and .go in an exercise folder, and web/tools/gen/main.go archives only .go/.md/go.mod, so a scene script cannot sit beside the exercise or ride in the per-exercise JSON. Clone-mode learners get only the README diagram; keep the two consistent or they drift.
- Scenes 3 and 4 show the fix (`select` plus cap 1). An ungated tab would reveal the answer before the learner solves it. Default to scene 1 and hide the mechanism scenes behind an explicit reveal that mirrors the Solution tab's spoiler gate.
- The generator reads git HEAD only, so scene scripts under web/src are hand-maintained beside the exercise. A later scaffold edit can silently invalidate a scene; name the symbols or commit each script models and review it with the exercise.
- 320 CSS px is tight: three lanes, labels, a buffer slot and a 150 ms marker can overflow. Put lane names above lanes inside one scaled SVG viewBox, avoid horizontal scroll, and check 320 px in light and dark.
- Timing must match the test exactly (100 ms deadline, 500 ms handler, 150 ms budget). A slowed or rounded animation that returns Serve late, or shows the handler value returned on timeout, teaches the opposite. Animate in event order, not wall-clock time.
- The lesson needs the frame after the return. A renderer that stops when Serve returns hides both the still-running handler and the leak; the timeline must run to at least 500 ms.
- `select` with both cases ready picks at random. Never draw the two branches as ready at the same instant; keep timestamps distinct (100 ms vs 500 ms) or label the tie-break.
- It is a scripted explainer, not a trace of the learner's edited main.go. Label it, or a learner will wonder why their fix is not reflected.
- Cost is shared, not per exercise: one lane/timeline renderer under web/src/components plus small scene modules under web/src/visualisations, lazy-loaded by id (import.meta.glob) so each exercise adds one small chunk. A bespoke component per exercise would balloon the bundle.
- prefers-reduced-motion must disable autoplay and pulsing; step mode must be an equal path, not a degraded one. Every control, including the scene selector, must be reachable and operable by keyboard with no hover-only affordance.
- This form is earned only by race and leak exercises. Reusing it for a mechanical signature or API change would add cost without teaching anything.

**Why this tier.** A compact lane timeline that proves the player: the deadline fires, the handler keeps running, the result slot decides the leak.


### Tier B — build next

<a id="06-fan-out-fan-in"></a>
#### 6 — Fan-Out, Fan-In: Concurrent Thumbnail Generation
`Tier B` · **high** · goroutine lanes · family `lanes` · effort M · README diagram: **no — draw it first**

**Pattern.** Fan-out / fan-in: spawn goroutines to call an independent blocking function concurrently, then fan results back through one shared channel, using sync.WaitGroup to know when to close it.

**Core idea.** When the work items are independent, concurrency converts a linear wall-clock cost into roughly one item's cost. The sequential loop is correct — it drops, duplicates and races nothing — so the fix is overlap in time, not different output. Fan-out starts the work; the results channel plus close-after-Wait is what fans it back in without losing a result.

**What prose and tests cannot show.** The scaffold passes both correctness tests and fails only a timing test, so the defect is invisible in the code's output: ten 150 ms ProcessImage calls run nose to tail (1.5 s) when they could overlap (~150 ms). The prose states the symptom as a number; it cannot show the staircase. Also invisible: a worker's `results <- th` blocks until the collector receives, and `close(results)` must happen only after `wg.Wait()` — closing from a worker ends the collector's `range` early or panics with "send on closed channel." Finally, completion order is not input order, which no test checks.

**Design.** A shared horizontal clock runs left to right. In the scaffold scene one lane holds ten 150 ms blocks laid nose to tail, so the clock crawls to 1.5 s while the result slice gains one slot per block. In the fan-out scene the same ten blocks spawn at t=0 as ten stacked lanes, each feeding one unbuffered results channel that a single collector lane drains into the slice; the clock stops near 150 ms with all ten slots full. A concurrency dial ties the two together: at 1 the staircase reassembles; each step up folds the lanes down until they fully overlap. The learner sees throughput come from overlap, not from making the work faster, and sees the collector as the single place that touches the slice.

**Scenes.**
1. **Scaffold: ten calls nose to tail** — One goroutine lane. Ten 150 ms ProcessImage bars run end to end; the virtual clock reaches 1.5 s, the slice fills one slot at a time, and a 500 ms budget line is crossed during the fourth call. The elapsed counter reads 1.5 s, matching the failing test's exact message. A small caption says the output is correct, only slow.
2. **Fan-out, fan-in: ten lanes, one collector** — Ten worker lanes spawn at t=0 and each blocks 150 ms inside ProcessImage. As each finishes it sends its Thumbnail on the unbuffered results channel; the send lights a block marker until the collector lane receives, then the collector appends a Thumbnail to the slice. The WaitGroup counter ticks down; at zero, close(results) ends the collector's range and the function returns at ~150 ms with ten results. Dropping the concurrency dial below 10 shows URLs queued and handed to workers one at a time.
3. **Close too early: why close follows Wait** — A worker closes results right after its own send. The collector's range ends after three results, the next completed workers hit 'send on closed channel' and the slice stops at three of ten. The scene replays with close placed after wg.Wait() and reaches ten, showing that close is a completion signal for the whole fan-in, not a per-worker action.

**Controls.** Play / pause, step forward and back one event, restart — the event list is fully addressable, so stepping is exact; Concurrency: 1 to 10 workers — at 1 the scaffold staircase returns; each step up folds the lanes together. This is the core knob and also models the pool-vs-goroutine-per-URL choice; Results channel: unbuffered vs buffered (capacity 10) — shows a send blocking until the collector receives, and that a buffer removes the wait but not the need for close; Fan-in mode: channel (completion order) vs indexed slice (input order) — ties the two accepted solutions; Scene selector: scaffold / fan-out / close-too-early.

**Annotations.** ProcessImage blocks for ProcessingLatency (150 ms); send results <- th blocks until a receiver is ready; receive <-results; close(results): no more sends; the range ends; wg.Done(): this worker's work is finished; wg.Wait(): returns only when the counter is 0; append to thumbnails happens on the collector goroutine only; goroutine W3 is blocked on the results channel; panic: send on closed channel; completion order is not input order; virtual clock, not wall clock.

**Data model.** Entities: Lane{id, kind: main|worker|collector|feeder, label}; Channel{id: jobs|results, cap, buffer[], blockedSenders[], blockedReceivers[]}; Slice{id: thumbnails, slots[]}; WaitGroup{counter}; Call{url, startT, endT, thumb}; Clock{virtualMs}. Events, each {t, kind, lane, target, detail}: spawn, callStart, callEnd, sendBlock, sendUnblock, send, recvBlock, recv, append{index, value}, wgAdd{n}, wgDone, wgWaitBlock, wgWaitRelease, close, rangeEnd, return, panic. A scenario is a deterministic ordered event list from a pure function script(scene, {concurrency, resultsCap, fanIn}) with a fixed duration (ProcessImage = 150 virtual ms) and a fixed visible completion order (worker i finishes at 150 + i*epsilon; all calls start at t=0). The renderer maps event index to a frame: lanes as rows, calls as 150 ms bars, the results channel as a horizontal queue between worker rows and the collector row, blocks as hold markers until the matching unblock, the slice as slots filling in. Use a 0..1500 ms axis for the scaffold and 0..300 ms for the fix, with a shared scale when both are shown. Frame state is derived only from the event index, so step, seek and restart are exact and reproducible; no wall-clock timers drive rendering.

**Code anchors.**
- 06-fan-out-fan-in/main.go:44-52 — the scaffold GenerateThumbnails; the `for _, url := range urls` at 47 and `thumbnails = append(thumbnails, ProcessImage(url))` at 48 are scene 1's nose-to-tail lane
- 06-fan-out-fan-in/mockimageprocessor.go:12-14 — ProcessingLatency = 150 * time.Millisecond and ProcessImage's time.Sleep(ProcessingLatency); every bar is this duration
- 06-fan-out-fan-in/check_test.go:80-100 — TestGenerateThumbnailsConcurrency; the budget = 500 * time.Millisecond at 93 is the line the scaffold's 1.5 s crosses
- 06-fan-out-fan-in/check_test.go:36-70 — TestGenerateThumbnailsCorrectness passes on the scaffold, so the visual must call it slow, never wrong
- solutions/06-fan-out-fan-in.md:68-104 — Approach 1: jobs and results channels, workers range jobs, wg.Wait() then close(results) at 93-96, collector range results at 99-101
- solutions/06-fan-out-fan-in.md:143-167 — Approach 2: one goroutine per URL (`go func(url string)` at 150), `results <- ProcessImage(url)` at 152, close after Wait at 156-159
- solutions/06-fan-out-fan-in.md:209-222 — Approach 2b: pre-sized slice, `thumbnails[idx] = ProcessImage(url)` at 216, wg.Go at 215; the indexed fan-in control
- solutions/06-fan-out-fan-in.md:188-193 — completion order vs input order, the fan-in mode toggle

**Verifier corrections — read before building.**
- Third-tab overflow: .doc-tabs (web/src/styles.css:540) has no overflow handling. Three labels at 14px/550 are about 211px; plus 24px container padding and the difficulty badge (DocPane.tsx:34) the bar is about 307px, which overflows the 260px desktop minimum pane (styles.css:506). The passed badge (DocPane.tsx:35-39) pushes it to about 378px, which overflows even the required 320px. The current two-tab bar is already tight; a third tab needs a shorter label/icon, hidden badges, or a scrollable tablist.
- Spoiler leak: the scene selector and control labels name the fix ('ten lanes, one collector', 'close follows Wait', 'results buffered', 'fan-in mode'). Showing that selector in a visible third tab reveals the solution before the learner solves it. spoiler_safe: true is false as specified. The fix visual must sit behind the same gate as DocPane.tsx:57-68 or inside the Solution tab.
- False placement dichotomy: the analyst says inlining needs a markdown directive that must also render on GitHub. But DocPane already composes a React <Markdown> (DocPane.tsx:53-58), so a component can render above or below the markdown with no directive. The real choice is not 'third tab or directive'.
- Width: the hard constraint is 320px, but the true worst case is 216px of content at the desktop minimum pane (styles.css:506 min 260px; styles.css:572-574 padding 22px each side), and 288px at a 320px phone (styles.css:1038 padding 16px). Ten lanes plus a collector plus a slice do not fit legibly at 216px; 'show 8 lanes' does not fix the horizontal axis cramping.
- Scene 3 ('close too early') states that the collector's range ends after three results and the slice stops at three of ten. That is one chosen interleaving, not a deterministic consequence; the exact count depends on the schedule. The scene text contradicts the analyst's own risk #3. Label it 'one possible interleaving' or drop it.
- Default-shape ambiguity: the scene is Approach 2 (one goroutine per URL), which is right, but the 'concurrency dial' and 'worker lanes' language can read as a required worker pool. README:19-23 explicitly says a fixed-size pool is not required. Label the default as one-goroutine-per-URL and keep any pool comparison clearly secondary.
- The 1-10 dial conflates overlap in time (06) with bounding concurrency (10-semaphore, 11-worker-pool), which README:21-23 defers. Keep the core sequential/concurrent toggle; if the dial stays, put it in the solution view and annotate that the 500ms budget is first met at 4 workers (ceil(10/4) x 150ms = 450ms, while 3 workers give 600ms).
- Scope is inflated: 3 scenes, 5 controls, a route change, and a tab-overflow fix for a ~10-line fix whose diagnosis is already in main.go:9-14 and the test message at check_test.go:96-98. Effort 'M' is optimistic; the single timeline should land first.
- Annotations are unspecified as a rendering mechanism. If they are hover tooltips, they violate the no-hover constraint. Put them in a persistent legend or bind them to the current step.
- Line references: mockimageprocessor.go:12-14 is cited for both ProcessingLatency and ProcessImage's time.Sleep; the sleep is at line 25. check_test.go:36-70 is padded (the test is 37-68). Minor, but the ties_to_code was not all checked.
- The close is performed by a separate closer goroutine after wg.Wait(), not by the collector lane. The data model's Lane kinds (main|worker|collector|feeder) have no closer lane, so the 'close(results) ends the range' moment has no actor. Add a closer lane or show the close in the main lane.
- Reduced motion: defaulting to a ~30-event step-through is a poor fallback, and autoplay is risky in a doc pane. Default to a static frame or 3-4 keyframes, with a 'next key moment' button; no autoplay at all; announce the frame through aria-live.
- Shared-scale legibility: a shared 0..1500ms axis makes the 150ms fix scene about 10% of the width, so the send/receive/close handoff is invisible. Use the shared scale for the 10x comparison, then zoom to 0..300ms for the fan-in detail, with a visible 'zoomed' label.
- Clone mode: the interactive visual is web-only; the clone-mode equivalent is the mandatory ASCII diagram that readme-diagram requires (lint.go:256-258) and that 06 lacks (exception at lint.go:39). This is a separate deliverable, not a note.

**Corrected design (use where it conflicts with the design above).**

Answer to the placement question: do not add a third tab. Keep the two-tab model and put the work in the two existing tabs. (1) Problem/README: add the mandatory ASCII diagram to 06-fan-out-fan-in/README.md in a plain fence (diagram chars, per lint.go:256-258) and remove the readme-diagram exception at lint.go:39. It shows one 10 x 150ms staircase against ten overlapping 150ms bars, 1.5s vs about 150ms, with a 500ms budget line. This is the clone-mode and non-spoiler visual. (2) Solution tab: after the existing spoiler reveal (DocPane.tsx:57-68), render the interactive explainer above the worked-solution markdown. Reusing the spoiler gate is structurally safe, needs no new Route.tab/parseRoute/routePath branch, and creates no tab-bar overflow. The component is lazy-loaded with a static map of dynamic imports and only mounted when revealed. (3) Both modes: the interactive explainer is web-only, because GitHub renders README markdown and cannot host a React component. A clone that runs npm run dev gets the same component; a raw clone or GitHub reader gets the ASCII diagram. The generator (web/tools/gen/main.go:459-497) reads git HEAD only, so the visual code must be committed to appear on the deployed site; the owner's uncommitted main.go is irrelevant. Design: use one vertical time axis (time flows down) so it fits 216-288px; default to one goroutine per URL with a pre-sized indexed slice (solution doc:209-222) and offer a toggle to the results-channel variant (solution doc:143-167) showing the unbuffered send blocking and close-after-Wait in a separate closer lane; show the WaitGroup counter and the collector/slice as the only writer. Use the shared 0..1500ms scale only for the 10x comparison, then zoom to 0..300ms for the handoff. Controls: play/pause, step, restart, sequential/concurrent toggle; a workers dial (2-10) and a channel/indexed toggle only in the solution view, labeled as secondary. If the close-too-early scene is kept, label it 'one possible interleaving' and do not state an exact collected count. Accessibility: no autoplay; default static; prefers-reduced-motion uses 3-4 keyframes and a 'next key moment' button; focusable buttons; aria-live summary; annotations in a legend, never hover; no horizontal page scroll. Styling: only the CSS variables at styles.css:1-87; no new npm deps. Keep the scripted constants (150ms, 10 URLs, 500ms budget) in a small config with comments pointing to mockimageprocessor.go:12 and check_test.go:92-93, and label the axis 'scripted virtual time' because the test uses synctest fake time.

**Verifier note.** Verified against HEAD. The scaffold does fail exactly as described: TestGenerateThumbnailsCorrectness (check_test.go:37-68) and TestGenerateThumbnailsConcurrentCorrectness (107-145) pass, and TestGenerateThumbnailsConcurrency (80-101) fails at 1.5s vs the 500ms budget (check_test.go:92-99) because 10 x 150ms runs nose to tail. The README has no ASCII diagram (readme-diagram exception at lint.go:39), so a visual adds something the prose cannot. The analyst's line references are mostly accurate (main.go:44-52, mockimageprocessor.go:12, solution doc 68-104/143-167/209-222, styles.css:540/1067, router.ts:9-18); only the mockimageprocessor.go:12-14 sleep range is wrong. The proposal is buildable with no new deps but not as specified: the third tab overflows the real pane widths and the scene selector spoils the fix. I agree with the 'high' tier, not with the placement or scope. The core timeline is substantive, not decoration, but the diagnosis is already in main.go:9-14 and the test message, so the visual's unique value is the shape and the fan-in handoff, which is why the corrected design keeps the interactive part behind the solution gate.

**Risks.**
- A scripted timeline is not a trace. Label it as an explainer and show a virtual clock; the real runner uses GOMAXPROCS=1, has no race detector, and synctest time is fake, so the learner must not read the bars as their own run's timing
- Ten lanes plus a collector at 320 px will be cramped. Use compact rows (about 28 px) and short labels, or show 8 lanes and state that the test uses 10; do not introduce horizontal page scroll
- A deterministic 'lost append' or 'duplicate result' scene would misstate a race as a fixed outcome. Use the deterministic close-too-early failure instead, or label the interleaving explicitly
- Adding a third tab touches the Route.tab union, parseRoute and routePath in web/src/router.ts (parseRoute currently coerces every non-solution tab to problem), DocPane props, and ExerciseView props; a missed branch silently sends deep links to the Problem tab
- Lazy-load the component per exercise id (a static map of dynamic imports) so the 43-exercise site does not bundle every visualisation; the existing per-exercise JSON stays untouched
- If the tab ever opens on the fan-out or close scene by default, it spoils the exercise. Default to the scaffold scene and put the fix scenes behind a reveal control like the Solution spoiler
- A 'worker pool' framing may conflict with the README, which blesses one goroutine per URL. Present the concurrency dial as a general limit and note that 10 means goroutine-per-URL
- The exercise README still has no ASCII diagram (readme-diagram backlog), so a learner reading the raw clone gets nothing interactive. Keep the diagram as a separate deliverable; do not pretend the tab fixes clone-mode
- Autoplay must respect prefers-reduced-motion (styles.css:1067 has the existing reduce block) by defaulting to step-through, and must pause when the pane is hidden so the event loop does not accumulate timers
- Accessibility: no hover-only detail; expose play, pause, step and restart as focusable buttons and announce the current event through an aria-live summary

**Why this tier.** Ten sequential 150 ms calls versus ten stacked bars; the canonical fan-out shape has no README diagram.

<a id="08-pipeline"></a>
#### 8 — Pipeline: Multi-Stage Number Processing
`Tier B` · **nice** · pipeline graph · family `lanes` · effort M · README diagram: **no — draw it first**

**Pattern.** Channel-connected pipeline stages with cancellation through one shared done channel (streaming pipeline plus broadcast shutdown).

**Core idea.** Stages overlap different items, never the same item: three goroutines cut wall time from the sum of all stages to roughly the slowest stage plus a small fill, while a single item's latency stays the sum of every stage. And a stage can only leave a blocked channel operation when that operation sits inside a select beside <-done.

**What prose and tests cannot show.** The blocking topology, which no printed value shows. The naive output is correct in every run, so "wrong" has no symptom in the result. A function call must return before the next call starts, so square is idle, not slow, while generator runs. The scaffold's generator does no work at all, so the 400ms is exactly two 200ms lanes. In the fixed version the generator lane spends nearly all its time blocked on an unbuffered send; it is not working. After done closes, a stage can be stuck on a send. A fix that guards only the receive leaves that goroutine blocked forever, and TestPipelineStopsEarly hides the leak by sleeping 10s before the synctest bubble closes.

**Design.** Four horizontal lanes stack vertically inside the 320px doc pane: generator, square, keepEven, and main. The x axis is time in WorkLatency units of 10ms, with a thin ruler and two budget lines: 250ms from TestPipelineStagesOverlap and 200ms from TestPipelineStopsEarly. Items are numbered tokens that carry their value from 1 to 10 and change from raw to squared to kept. In the default Batch scene the generator lane is one tick wide, because generator only returns nums; the tokens drop into a visible slice bin at the end of the lane, and square cannot light up until that bin is full. keepEven stays grey and empty until square's bin is full. The ruler stops at 400ms, past the 250ms line, and no lane overlaps another. In the Pipeline scene the same tokens leave each lane the moment they exist: the generator lane turns amber (blocked on an unbuffered send) between items, square and keepEven run in a diagonal stagger, and the ruler stops near 220ms, just under the budget. A red done line can sweep in at any tick; every lane blocked at that moment flashes, then greys out as its select wakes and closes its output.

**Scenes.**
1. **Batch: three lanes, one at a time** — The scaffold symptom, as the default scene. generator finishes in one tick and drops all tokens into a slice bin; square then runs 20 ticks alone; keepEven runs the last 20 ticks alone. The lower two lanes are visibly empty while the lane above works. The ruler stops at 400ms, past the 250ms budget line. Labels: 'generator returns []int, nothing streams' and 'square waits for generator to return'.
2. **Streaming: items in flight** — The fixed shape. Token 1 leaves generator at tick 1 and square starts on it while generator still holds token 2. The generator lane is amber, blocked on an unbuffered send, between every item. square and keepEven form a diagonal stagger, and the ruler stops near 220ms, under the budget. A callout keeps one token lit from entry to exit: its own latency is still 3 units, so only throughput rose.
3. **done fires mid-run** — A red done line drops at the chosen tick. generator is blocked on a send; square is blocked on a receive from in. Both wake through case <-done, both defer close(out), keepEven sees !ok and exits, and main's range ends one tick later. The stalls resolve in one frame. A comparison slide plays the same tick on the Batch scaffold, which never reads done and grinds to 400ms.
4. **Half-guarded select leaks** — Toggle 'guard receive' on and 'guard send' off. After done, square leaves its receive but stays blocked on out <- n*n forever, because keepEven has exited. The square lane stays amber and the total never finishes. This is the goroutine leak that the tests hide behind the 10s sleep.

**Controls.** Play / pause / step / restart, on buttons and on Space, Left/Right and R, with visible focus rings; Speed 0.5x / 1x / 2x; Close done, plus a draggable done tick on the ruler; Independent toggles: guard the receive, guard the send (both on by default in the fixed scene; turning either off shows the stall or the leak); Mode switch Batch (scaffold) | Pipeline (fix), defaulting to Batch on every open; Input size 5 / 10 / 20, so the 3N versus N+2 gap widens on screen.

**Annotations.** 'generator: return nums: a slice, nothing streams' (scaffold); 'stage idle: not started, because the call has not returned'; 'SimulateWork(): WorkLatency = 10ms per item' (mockwork.go:8); 'send on an unbuffered channel blocks until a receiver arrives'; 'receive: case n, ok := <-in'; 'select { case out <- n: case <-done: return }: the only escape from a send'; 'defer close(out): how the next stage learns there is no more input'; 'range evensCh ends when keepEven closes its output' (Pipeline); 'done closed: one channel, three goroutines wake independently'; 'goroutine leaked: still blocked on out <- n*n after everyone else exited'; 'budget 250ms: TestPipelineStagesOverlap' and 'budget 200ms: TestPipelineStopsEarly', drawn as ruler lines.

**Data model.** Entities. Goroutine{id: generator|square|keepEven|main, state: idle|working(item)|blockedSend(ch)|blockedRecv(ch)|exited, item}. Batch mode runs the three stages as plain calls, not goroutines; model them as lanes with state batchRunning so one renderer draws both modes. Channel{id: numsCh|squaresCh|evensCh|done, cap: 0, contents: at most one item at the rendezvous, closed: bool}. Item{value, index, stage, state: queued|working|filtered|emitted|abandoned}. SliceBin{mode: batch only, items: []Item}, the returned []int that the next stage must wait for.
Events, one per deterministic tick, precomputed and never sampled from a live run: spawn(stage), work(stage, item, dur = WorkLatency), send(stage, ch, item), sendBlock(stage, ch), recv(stage, ch, item), unblock(stage), filter(item, keep|drop), close(ch), cancel() = close(done), selectWake(stage), exit(stage), return(stage).
Timeline. tick = one WorkLatency unit, ms = tick * 10. frame[i] = {laneStates, channelContents, itemPositions, elapsedMs, doneOpen}. The renderer seeks by index; play and step only move the index, so nothing is timing-dependent. Totals with 20 items: batch = 40 ticks = 400ms (generator contributes 0), pipeline = about 22 ticks = 220ms. n is a parameter (5, 10, 20).

**Code anchors.**
- 08-pipeline/main.go:58-60: `func generator(...) []int { return nums }`; it calls no SimulateWork, so its lane is one tick in Batch mode, and 400ms = two 200ms lanes.
- 08-pipeline/main.go:66-73: square's `for i, n := range nums` loop with SimulateWork(); the whole batch runs before the function returns.
- 08-pipeline/main.go:79-88: keepEven's loop and append; the second half of the 400ms.
- 08-pipeline/main.go:92-94: `return keepEven(done, square(done, generator(done, nums...)))`. Go evaluates the arguments first, so the three calls are forced into sequence. This one line is the bug.
- 08-pipeline/mockwork.go:8-14: WorkLatency = 10ms and SimulateWork(); the ruler's unit and the per-tick cost.
- solutions/08-pipeline.md, Approach 1: `out := make(chan int)`, `go func(){ defer close(out) ... }`, the send select and the receive select. The amber and escape states map onto these lines.
- 08-pipeline/check_test.go:77 and :115: `const budget = 250 * time.Millisecond` and `200 * time.Millisecond`; draw them as budget lines on the ruler.

**Verifier corrections — read before building.**
- The verdict rests on a false premise. The proposal says 'no value and no test name shows where the time goes'. The scaffold fails with exactly that information: `Pipeline took 400ms to process 20 items; want well under 250ms - looks like generator, square, and keepEven are running one at a time over the whole batch` and `Pipeline took 2s to return after done was closed ... want well under 200ms` (check_test.go:79 and :117). I reproduced both from HEAD in a temp copy. The README prose also says 'Nothing overlaps'. The visual adds geometry and intuition, not a diagnosis.
- The half-guard scene is inverted. I wrote the variant the proposal describes (receive guarded, send unguarded). TestPipelineStopsEarly does not hide it; it panics with `panic: deadlock: main bubble goroutine has exited but blocked goroutines remain`, naming `square.func1()` at `chan send (durable)`. The 10s sleep at check_test.go:133 does not hide a permanently blocked goroutine. The half-guard the tests actually miss is the reverse: sends guarded and receives left as a plain `for range in` passes all four tests. The visual's toggles would teach the wrong direction.
- The streaming scene's amber 'blocked on an unbuffered send between every item' cannot happen. With WorkLatency fixed at 10ms (mockwork.go:8) and unbuffered handoffs, the downstream stage is already parked on its receive when the upstream arrives. I instrumented every send in the fixed solution: each matched with `blocked 0s`. At n=20 the run is exactly 220ms, made of three offset 200ms work bands (generator 0-200, square 10-210, keepEven 20-220), with no send-block intervals to colour amber.
- The batch generator is instant, not 'one tick'. It returns the slice with no SimulateWork (main.go:58-60), so the scaffold measures square 0-200ms and keepEven 200-400ms; a 10ms generator tick yields 410ms and contradicts the measured 400ms and solutions/08-pipeline.md. The proposal's risk 1 is also wrong that generator does no work 'in either version': the fixed generator pays SimulateWork per item (solutions/08-pipeline.md:113). So the fix does more total work (600ms) in less wall time (220ms). The control label '3N versus N+2' is wrong: batch wall time is 2N (0+N+N), pipeline is N+2. TestPipelineStagesOverlap's own comment ('3 * 20 * WorkLatency', check_test.go:48) is likewise stale and must not be copied into the visual.
- The two budget lines measure different things. The 250ms in check_test.go:77 is a full-run budget at n=20. The 200ms in check_test.go:115 is a return-after-cancel budget, measured from the done line. Drawing both on one 0-400ms total-run ruler is incoherent, and at n=20 the pipeline's no-cancel total (220ms) already sits past the 200ms line. The size control makes this worse: at n=5 the batch takes 100ms and at n=10 it takes 200ms, so the scaffold would pass the 250ms overlap test at those sizes; only n=20 calibrates that budget. The visual must fix n=20 for the budget comparison or explain the calibration.
- spoiler_safe is not honest as written. The default Batch scene is safe, but the one-click switch to Pipeline exposes the fixed channel-stage shape, and the done and guard scenes expose the select structure. A new Visual tab would bypass the Solution tab's reveal gate in DocPane.tsx:57-68. Only the scaffold scene may be reachable before the learner reveals the solution.
- A third tab does not fit 320px. The row already holds Problem (~68px), Solution (~76px), the medium badge (~57px), the passed badge (~72px), 24px padding and 12px of gaps, about 307px; adding Visual (~60px) reaches about 367px, and .doc-tabs has no flex-wrap (styles.css:540-558). It also forces the `tab: "problem" | "solution"` type in router.ts:6 to change, and App.tsx:86, ExerciseView.tsx:10 and the DocPane props to carry a third value, with conditional rendering so the other exercises do not get a dead tab.
- Token density does not fit. The plot is narrower than the proposal assumes: 320px minus .doc-body padding (32px on mobile, 44px on desktop, styles.css:574) minus a 52px gutter leaves 224-236px. Over a 400ms axis that is about 5.7px per 10ms tick. Twenty 14px numbered tokens at the offered n=20 cannot be placed; the proposal's own '8 items at 14px' contradicts the 5/10/20 control. The doc pane's CSS floor is 260px (styles.css:506 `minmax(260px, ...)`), so a 320px-only layout is fragile.
- The done scene asserts a deterministic state at a nondeterministic instant. TestPipelineStopsEarly closes done at exactly t=10ms, the same instant the generator reaches its first send and square is parked on its receive. Both the send and the done case can be ready, and Go picks at random, so the claim that both lanes 'wake through case <-done' is not guaranteed. Choose a mid-work tick (for example t=15ms) for the scripted scene, or label it as one possible schedule.
- The solution doc's claim that guarding only one direction 'leaves a gap' (solutions/08-pipeline.md:358-362) is not what the suite shows: a send-only guard passes all tests. The visual's toggle lesson would contradict the suite unless the doc is scoped or corrected first. This is a separate doc fix in the same change.
- Effort M is low for four scenes, six controls, two guard toggles, a draggable done tick, three speeds and three sizes, one scene of which rests on a false premise. The corrected scope is smaller and is still M only if the lane renderer is reusable.
- The clone-mode answer is missing. The interactive timeline is web-only by nature, but the repo already mandates the clone-mode artifact: the readme-diagram rule (tools/check/lint.go:257) requires an ASCII today-vs-goal diagram, and `readme-diagram 08-pipeline` is an exception at tools/check/lint.go:40. Draw the diagram in the README and delete the exception. Do not build a terminal animation, and do not add files to the exercise folder (layout rule at tools/check/lint.go:154).

**Corrected design (use where it conflicts with the design above).**

PLACEMENT (answers 'tab or existing tabs'): no third tab. Render a collapsed 'Timeline' panel at the end of the Problem tab that shows only the scaffold (Batch) scene, and render the full interactive comparison in the Solution tab after the existing 'Show the solution' reveal. This splits at the spoiler boundary, reuses the reveal gate, needs no change to router.ts:6 or App.tsx:86, and avoids the 320px tab-row overflow. A third 'Visual' tab is rejected for those reasons.

CLONE MODE (answers 'both modes or web only'): the interactive panel is web only. Clone mode gets the static ASCII today-vs-goal diagram that the lint rule already requires: generator is a point at t=0, square 0-200ms, keepEven 200-400ms; the goal shows generator 0-200, square 10-210, keepEven 20-220. Add it to 08-pipeline/README.md and delete the `readme-diagram 08-pipeline` exception. Optionally add a link to https://go-ce.vercel.app/08-pipeline. Do not write a terminal visual.

VISUAL FORM: keep four horizontal lanes (generator, square, keepEven, main) with time on x, but draw work as continuous bands, not per-item numbered tokens. Batch ruler 0-400ms with the 250ms full-run budget; generator is an instant marker, not a 10ms tick. Pipeline ruler 0-250ms with the same full-run budget; three offset 200ms bands. Show the punchline: total stage work rises from 400ms to 600ms while wall time falls from 400ms to 220ms. Do not draw amber send blocks; the handoffs cost zero time. Item boundaries are thin ticks; number only the active item in a caption ('item 7 of 20'). At n=5/10/20, scale the bands and drop per-item marks above n=5; say that the 250ms budget is calibrated at n=20, where the batch fails and the pipeline is 30ms under.

CANCELLATION: fire done from a button or a range input at a mid-work tick such as t=15ms. Each stage finishes the item it holds, then exits at its next select; the pipeline returns within one WorkLatency. Draw the 200ms post-cancel budget measured from the done line, not from t=0. State that the select choice is one possible schedule.

GUARDS: replace the two independent toggles with one accurate comparison: send guarded -> all tests pass; send unguarded -> TestPipelineStopsEarly panics with the deadlock message naming the blocked send. Add a note that the receive guard is defensive and not observable in this pipeline because upstream closes on done. Fix or scope solutions/08-pipeline.md:358-362 to match.

CONTROLS: play/pause, step, restart and speed; drop the size switch or keep it as a secondary readout. Native buttons, start paused at frame 0, arrow keys step when the chart has focus, no hover-only control, and honor prefers-reduced-motion by advancing instantly or showing a static contact sheet. Load the component with React.lazy or import.meta.glob only when the panel opens or the solution is revealed. Design for the 260px CSS floor and verify at 320px: about a 48px label gutter and a 210px plot, with only 0/250/400 axis labels.

LIGHTER OPTION: the Problem tab's ASCII diagram plus a three-row table (n=5/10/20 -> batch 100/200/400ms, pipeline 70/120/220ms) carries the overlap lesson with no JavaScript. Reserve the interactive lanes for the cancellation exit, which is the only part a static diagram cannot show.

**Verifier note.** I read all the named files from git HEAD and ran the exercise in a temp copy (/tmp/pipe08.*), not in the repo; no repo file was changed. Empirical results: scaffold fails with 400ms and 2s exactly as solutions/08-pipeline.md:73-76 says; the fixed solution takes 220ms at n=20; every send in the fixed solution blocks 0s; receive-guarded/send-unguarded panics with `deadlock: main bubble goroutine has exited but blocked goroutines remain`; send-guarded/receive-unguarded passes all four tests. Feasibility is otherwise sound: no new dependency is needed (React plus SVG or divs), the CSS variables cover light and dark, and the chunk can be lazy per id. File citations: DocPane tabs web/src/components/DocPane.tsx:26-32; router type web/src/router.ts:6; route use web/src/App.tsx:86; doc pane floor and padding web/src/styles.css:506 and :574; tab styles :540-558; reduced motion :1067; layout rule tools/check/lint.go:154; diagram rule :257 and the 08 exception :40; generator input extension web/tools/gen/main.go:484-486; deps web/package.json. Verdict note: 'high' would be defensible only if the site builds one reusable lane component also used by 18-bounded-pipeline-backpressure and 26-pipeline-error-handling; for 08 alone the exercise already fails loudly with the number and the cause, so 'nice' is the honest tier.

**Risks.**
- Generator does no SimulateWork in either version. A visual that gives it a 20-unit lane shows 600ms and contradicts the observed 400ms in solutions/08-pipeline.md. Model the batch generator as one tick.
- The numbers 400ms and 2s in the solution doc come from WorkLatency = 10ms with 20 and 100 items. Derive every ruler value from the constant; do not copy the log text.
- tools/gen/main.go:484 ships only .go, .md and go.mod, and the layout rule (tools/check/lint.go:154) forbids new files in 08-pipeline/. The scene data and the component must live under web/src/, lazily imported by id, with no file in the exercise folder.
- Adding a third value to `tab: "problem" | "solution"` (web/src/router.ts:8-19) touches App.tsx:86 and the DocPane props. Render the tab only when a visualisation exists, or 43 exercises get a dead tab.
- .doc-body is overflow-y: auto (web/src/styles.css). A tall lane chart scrolls away from its controls; pin the controls and give the chart canvas a fixed height.
- At 320px, lane labels must not wrap. Use a 52px monospace gutter, or switch to a vertical waterfall through a container query.
- Do not call the scaffold wrong. It passes correctness. The captions must say 'no overlap' and 'cannot stop early'.
- Reduced motion: open in step mode, never autoplay on mount. The same frames must read as a static contact sheet.

**Why this tier.** Pipeline stages as rows; the share of time and the guard asymmetry become visible. Fix the solution doc first.

<a id="13-channel-of-channels"></a>
#### 13 — Channel of Channels (Bridge Pattern): Merging Dynamic Log Shards
`Tier B` · **high** · lane board · family `lanes` · effort M · README diagram: **no — draw it first**

**Pattern.** Channel of channels (bridge pattern): fan-in over a set of channels that arrives at runtime, with head-of-line blocking and goroutine-per-shard draining.

**Core idea.** Reading the outer channel once drops every later shard. Looping back to it is necessary but not enough. The outer channel and every open shard must be drained concurrently, so that no stalled shard sits on the path that reads the next shard.

**What prose and tests cannot show.** A sequential bridge drains the current shard fully and only then reads the next one. It produces exactly the same output as the correct version on every test but the starvation one. The learner cannot see from the code shape, or from a passing run, that one stalled shard parks the receive that would pick up a shard still waiting on chanStream. The learner also cannot see the leak: the scaffold's abandoned shards leave producer goroutines blocked forever on `lines <- ...` (mockloghub.go:35).

**Design.** Draw a lane per goroutine and a vertical rail per channel. The lanes are hub, producers P0 to P4, the bridge goroutine (scaffold, sequential, or dispatcher plus forwarders), and main. The rails are chanStream, shard-0 to shard-4, valStream, and done. Time runs downward in ticks. A line is a small chip, for example "shard-1-line-0", that slides along a lane to a channel rail and handshakes with the receiving lane in the same tick. A goroutine that cannot proceed freezes on the spot and gets a short tag: "blocked on <-chanStream", "blocked on lines <-", or "stuck: recv never returns". At 320 CSS px, the channel rails shrink to 2px lines with 11px labels, and finished shards collapse to one summary row. Use the existing tokens: --bg-elev for lane bodies, --border for rails, --accent for moving chips, --fail plus a dashed outline for blocked lanes. Never rely on color alone.

**Scenes.**
1. **Scaffold: 4 of 20 lines** — Five shards arrive 5ms apart. Bridge takes shard-0 off chanStream, forwards its 4 lines, sees shard-0 close, returns, and closes valStream. main prints "Total log lines: 4". Shards 1 to 4 freeze at "send blocks" forever, and the hub freezes on its next send of a shard channel. The footer shows TestBridgeFlattensAllShards failing: got 4, want 20, after the 2s timeout.
2. **Loop back, still starves** — A stopgap returns to chanStream for each shard, but only after the current one drains. shard-0 never sends and never closes. The hub already holds shard-1 and is parked on its send to chanStream. Bridge is parked on shard-0's receive, so it never issues the receive that would take shard-1. Nothing moves and the output stays empty. The footer shows the 200ms starvation timeout from TestBridgeDoesNotStarveOnSlowShard.
3. **Concurrent fan-in (gated)** — The dispatcher takes each shard as it arrives and spawns a forwarder lane for it. The stuck shard-0 forwarder freezes alone. shard-1's line reaches valStream and main prints it. The wg counter tracks the live forwarders. close(chanStream) ends the dispatcher, wg.Wait() waits for the last drain, and only then does valStream close. The footer shows all three tests passing.
4. **done closes** — From the middle of scene 3, the learner presses Close done. The done case fires in every select: the dispatcher, every forwarder, and the send to valStream. Every bridge lane exits in one tick and valStream closes. main's range ends. The hub's producer lanes stay parked, because nobody reads them again. The caption says this mirrors TestBridgeStopsOnDone, since main never closes done.

**Controls.** Play / Pause, Step, Restart: real buttons with visible focus rings; Space toggles play, Right arrow steps; no control needs hover.; Scene stepper for scenes 1 to 4, so a keyboard user can jump to a state without waiting.; Stall shard 0 toggle (on by default in scenes 2 and 3): the control that turns a happy path into head-of-line blocking.; Close done button: fires the done case and shows which lane exits first.; Reveal the fix: a spoiler gate in front of scene 3, worded like the Solution gate.; Speed 0.5x / 1x / 2x, or no autoplay at all when prefers-reduced-motion is set..

**Annotations.** blocked on <-chanStream; blocked on lines <- (send has no receiver); stuck shard: recv never returns; handshake (send and recv in one tick); close(shard-N); close(chanStream); close(valStream); goroutine spawn; wg.Add(1) before the spawn; wg.Wait() before the deferred close; case <-done; dropped line (never received).

**Data model.** Entities: goroutine {id, role: hub | producer | bridge | dispatch | forwarder | consumer, label}; channel {id, elem: string | "chan (<-chan string)", capacity, closed}; counter {id: "wg", value}; line {id, text, shard, index}. Events are {tick, actor, kind, target?, value?}: spawn, send, recv (a send and a recv at one tick form one handshake), block(goroutine, channel, op: send | recv | select), unblock, close(channel), cancel(done), wgAdd, wgDone, exit, drop(line). state(t) is a pure function over the first t events and returns goroutine status (ready | running | blocked | exited), channel contents, closed flags, delivered count, and the wg value. Step sets t = t + 1. Play advances t on a timer. Restart sets t = 0. A scene is {id, implementation: scaffold | sequential | concurrent, events[]}. The hub events are identical across implementations; only the bridge lanes and their events differ, so the toggle can swap implementations at the same tick. Scenes 3 and 4 use the concurrent event list.

**Code anchors.**
- 13-channel-of-channels/main.go:51 — `stream, ok := <-chanStream`: the only read of the outer channel in the scaffold.
- 13-channel-of-channels/main.go:60-63 — `case v, ok := <-stream: if !ok { return }`: the return when the first shard closes.
- 13-channel-of-channels/main.go:49 — `defer close(valStream)`: the output closes with the first shard, not the last.
- 13-channel-of-channels/main.go:77-78 — main creates done and never closes it.
- 13-channel-of-channels/mockloghub.go:35 — `lines <- fmt.Sprintf(...)`: the send that blocks forever once Bridge abandons the shard.
- 13-channel-of-channels/mockloghub.go:39 — `shardStream <- lines`: the hub blocks on the outer send when Bridge never takes the next shard.
- 13-channel-of-channels/starvation_test.go:27-29 — `stuck` never sends and never closes; `ready` holds one buffered line.
- 13-channel-of-channels/README.md:26-32 — the paragraph that names head-of-line blocking.
- solutions/13-channel-of-channels.md:145 — `case stream, ok := <-chanStream` in the dispatcher loop.
- solutions/13-channel-of-channels.md:150 and :176 — `wg.Add(1)` before the spawn, and `wg.Wait()` before the deferred close.
- solutions/13-channel-of-channels.md:155-167 — the per-shard select over the shard channel and done.

**Verifier corrections — read before building.**
- Scene 1 shows a state the code cannot reach. After Bridge takes shard 0 and never reads chanStream again, StartLogHub blocks on `shardStream <- lines` (mockloghub.go:39) for shard 1, so only producer 1 is ever spawned; shards 2-4 never start. The P0-P4 lanes and "shards 1 to 4 freeze at send blocks" are wrong. The faithful state is: shard 0 drained and closed, producer 1 blocked on `lines <-`, hub blocked on the shard send, shards 2-4 not spawned.
- Scene 1's failure footer is wrong. The naive Bridge closes valStream with shard 0 (main.go:49,60-63); the test's collect loop breaks on the closed channel (check_test.go:51-53) and fails at once with 'got 4 total log lines, want 20' (check_test.go:66-67). It does not fail after the 2s timeout. That timeout (check_test.go:46,56-57) only fires if the output never closes.
- Scene 3 cannot happen as written. With a stuck shard, its forwarder never calls wg.Done, so wg.Wait never returns and valStream never closes. The scene still claims 'all three tests passing'. Also `close(chanStream)` belongs to the 5-shard flatten test; the starvation test never closes chanStream (starvation_test.go:25-34). Split the two scenarios.
- The data model's claim that hub events are identical across implementations is false. The scaffold's hub blocks after shard 1 and spawns one producer; the concurrent hub sends all shards and closes chanStream. A same-tick implementation swap cannot work, and a 'Stall shard 0' toggle would need a second event list. Give each scene its own full script.
- The 320px form does not fit. At 320px the workspace stacks and .doc-body leaves 288px (styles.css:986,1037); on desktop the doc pane can be 260px (styles.css:506). Thirteen goroutine lanes at about 21px each cannot carry 11px labels plus line chips. Collapsing finished shards does not reduce scene 3's live lanes (dispatcher, five forwarders, hub, producers, main).
- spoiler_safe is not honest yet. The annotation list names the fix ('goroutine spawn', 'wg.Add(1) before the spawn', 'wg.Wait() before the deferred close'), and a four-entry stepper labeled 'Concurrent fan-in' names the answer before any reveal. Gate the annotation list and the scene 3/4 labels, not only the scene body.
- The verdict reason overstates the case. The learner does not meet the lesson 'only as a 200ms timeout': starvation_test.go:44 prints 'Bridge starved: a stuck shard blocked lines from a later, ready shard', and README.md:26-32 states the same mechanism in prose. The claim that two plausible fixes 'pass the same tests' is false: the sequential shape fails TestBridgeDoesNotStarveOnSlowShard by design (solutions/13-channel-of-channels.md:89-104).
- Scene 4 says 'main's range ends', but TestBridgeStopsOnDone never runs main: it reads three values and closes done itself (check_test.go:89-119), and the scaffold's main never closes done (main.go:77-78). 'Every bridge lane exits in one tick' also draws simultaneous exits, which GOMAXPROCS=1 cannot produce (web/README.md:43).
- The design misses the honest consequence. A correct concurrent Bridge does not free a stalled shard; valStream stays open until done closes. That is the real lesson of the concurrent scene and should be the headline, not 'all tests pass'.
- A third tab is unnecessary surface for one exercise. It touches router.ts:4-17, ExerciseView.tsx:10, App.tsx:86 and DocPane.tsx:26-32. The widget belongs at the end of the Problem tab, before the pager (DocPane.tsx:71). It must not go in the Solution tab, which sits behind the spoiler gate (DocPane.tsx:55-69).
- Clone mode is not answered by the widget. The widget runs only in the browser. Add the same board as an ASCII block in 13-channel-of-channels/README.md: it renders on GitHub and in the web Problem tab, and it clears the existing readme-diagram exception (tools/check/lint.go:43).
- The time-down lane drawing is mostly decoration for this exercise. The time axis matters in the scaffold scene only; scenes 2-4 are 'nothing moves' or a single step. A state board with a short event log shows the same block state in less space and at every width.
- Minor citations: the blocked-producer comment is at check_test.go:24-30, not :17-22; the literal failure text is longer than 'got 4, want 20'. The other ties_to_code line numbers check out (main.go:49,51,60-63,77-78; mockloghub.go:35,39; starvation_test.go:27-29; README.md:26-32; solutions/13-channel-of-channels.md:145,150,176).

**Corrected design (use where it conflicts with the design above).**

Keep the widget, but change its form, scripts, placement and scope.

FORM. Draw a block-state board, not 13 lanes. For the current step, show one row per goroutine that exists: role, state (ready, running, blocked, exited), and the channel it waits on, for example "bridge: blocked on <-shard-0". Beside it, show a channel panel: chanStream, each shard, valStream, done, with open/closed, pending values and delivered count. Add a one-line event log for the last 3 steps and a "step 3 of 9" counter. Advance at most one goroutine per step, so the view matches GOMAXPROCS=1. This fits in 288px: about 8 rows at 22px in 11.5px mono text. Keep an SVG lane view only for panes 560px and wider.

SCENES. Split what the proposal merged, and give each scene its own full event list.
A. Scaffold (default; 5 shards x 4 lines, the real test): shard 0 delivers 4 lines and closes; Bridge returns and closes valStream; main prints 4 of 20. Show the hub blocked on chanStream <- shard-1, producer 1 blocked on lines <-, and shards 2-4 "never started". Footer: the exact immediate failure, "got 4 total log lines, want 20". No timeout.
B. Sequential stopgap (default): the starvation_test.go:25-34 script. Bridge parked on <-stuck; hub parked on chanStream <- ready; 0 delivered; the 200ms failure text.
C. Concurrent fan-in, same stuck shard (gated): dispatcher waits on chanStream; forwarder A waits on <-stuck; forwarder B delivers shard-1-line-0; valStream stays open; wg = 1 live. Then "Close done" exits every lane, wg reaches 0, valStream closes. Caption: the stalled shard alone keeps the output open forever; only done closes it.
D. Healthy close (gated, optional): 5 healthy shards; chanStream closes; wg.Wait reaches 0; valStream closes; main prints 20 of 20. This scene, not C, teaches close-after-drain.

CONTROLS. Play/Pause, Step back and forward, Restart, scene select. Scope Space and arrow keys to the focused widget. Add focus-visible rings. Turn autoplay off when prefers-reduced-motion is set, and extend the existing block at styles.css:1067 so no chip animation runs. Step must reach every state, including the stuck and done states. Drop the "Stall shard 0" toggle; fixed scripts are enough.

SPOILER. Default scenes A and B. Put scenes C and D, the stepper labels, and the annotations that name the fix behind a "Show the fix" button styled like .spoiler (styles.css:592). The default view must not print wg.Add, wg.Wait, or "one goroutine per shard".

PLACEMENT. Render the board as a section at the end of the Problem tab, before the pager (DocPane.tsx:71), only when a scene exists for that exercise id. Do not add a third route: it touches router.ts:4-17, ExerciseView.tsx:10, App.tsx:86 and DocPane.tsx:26-32 for a single exercise. Do not put it in the Solution tab. If several exercises later ship scenes, promote it to a third tab then.

MODES. The interactive board is web-only. For the clone flow, add the static ASCII board to 13-channel-of-channels/README.md; it works on GitHub and in the web Problem tab, and clears the readme-diagram exception at tools/check/lint.go:43. Do not try to make the animation work outside the web app.

TECH. Add web/src/visuals/registry.ts mapping exercise id to a dynamic import, so Vite emits one chunk per exercise and the site keeps its lazy-load behaviour. Draw with divs and SVG; use the CSS variables; add no npm dependency. Scene data stays under web/src, because the layout rule and web/tools/gen/main.go:485-488 keep the exercise folder clean.

**Verifier note.** Verified against git HEAD. The bug is real: the scaffold forwards only shard 0 (main.go:45-74); the mock hub blocks on the next shard send (mockloghub.go:39) and producer 1 blocks on its first line (mockloghub.go:35). The starvation script is faithful (starvation_test.go:25-34), and the mock timing supports a scripted schedule. The ties_to_code line numbers check out, apart from the comment citation noted above. has_readme_diagram:false is honest, and 13 is already a readme-diagram backlog exception (tools/check/lint.go:43). I agree the blind spot is a schedule, not a value, but the proposal overstates it as "must": README.md:26-32, the starvation test's failure text, and the solution doc's walkthrough (lines 89-104) already state the mechanism once the learner reads them. A short interactive board is a strong aid, so I rate it high, not must. Feasibility is with-changes: no new dependency is needed, the tokens exist, a dynamic import gives the required lazy loading, and the reduced-motion block can be extended; the 13-lane time drawing and the scene scripts are the parts that must be replaced.

**Risks.**
- A scripted schedule can show an order Go cannot produce. Check every tick against the real code, and label the view "one possible schedule".
- Scene 3 is the answer. Keep it behind a reveal, and do not print the fixed Bridge source. Showing it by default breaks the spoiler rule that DocPane.tsx:55-69 enforces for the Solution tab.
- An animation can read as true parallelism. The browser runs with GOMAXPROCS=1 (web/README.md:43), so blocked-to-ready must be the only source of overlap. Never draw two goroutines that execute at the same instant.
- Scene 1 must end with the hub goroutines stuck, not a clean exit. The real test leaves them blocked (check_test.go:17-22). A tidy ending teaches the wrong lesson.
- The starvation test lives in starvation_test.go, not check_test.go. Any scene keyed off file names must read the whole files list in the per-exercise payload.
- 320px is tight: five shard lanes plus four channel rails do not fit. Collapse drained shards to one summary row, and keep the key blocked state visible without horizontal scroll.
- Do not add an npm dependency. Draw with SVG or plain divs and CSS transforms, and lazy-load the scene data by exercise id.
- Scene data must live in web/src. The layout rule (tools/check/lint.go:154) forbids extra files in the exercise folder, and gen reads only .go, .md and go.mod from HEAD (web/tools/gen/main.go:485).
- Reduced motion: autoplay must be off, and Step must reach every state, including the stuck ones and the done-cancel state.
- Scene 4 must say it mirrors TestBridgeStopsOnDone. The scaffold's main never closes done (main.go:77-78), so a learner who looks for that call will not find it.
- Show the tab only for exercises that ship a scene script. A third tab on all 43 exercises, most empty, weakens the exercise list.

**Why this tier.** Head-of-line blocking is a schedule, not a value; a block-state board shows the hub stuck on one shard.

<a id="19-actor-model"></a>
#### 19 — Actor Model: A Bank Account with No Locks
`Tier B` · **high** · goroutine lanes · family `lanes` · effort M · README diagram: yes

**Pattern.** Actor model / message passing ("share memory by communicating"): one long-lived goroutine owns mutable state and processes a request struct from an unbuffered channel one at a time, with a per-request reply channel; contrasted against an unsynchronized struct where many goroutines read-modify-write a shared field.

**Core idea.** If exactly one goroutine ever touches a field, there is nothing to lock — correctness comes from ownership and serialization, not from guarding. But that ownership buys a lifetime: the actor goroutine and every caller's rendezvous (send, then wait for a reply) must both be designed, because a missed reply wedges the actor and a missed Close leaks it.

**What prose and tests cannot show.** Three invisible things. (1) The interleaving: the scaffold's `a.balance = a.balance + amount` (main.go:67) is a read, an add and a write, and two of them can overlap so a deposit vanishes. In the browser the race detector does not exist (web/README.md), so the learner only ever sees "final balance 10836, want 11000" — a number, never the mechanism. (2) Blocking: a call is two blocking steps (send on `requests`, receive on `reply`), and the actor blocks in between on its own reply send. A forgotten `<-reply` (solution doc line 127) does not corrupt anything — it freezes every future call forever, so the failure looks like a hang, not a wrong answer. (3) Lifetime: an idle actor goroutine is indistinguishable from a healthy one by reading the code; only the goroutine count and the synctest bubble reveal the leak.

**Design.** A left-to-right time axis. On the left, a stack of three caller lanes labelled A, B, C (a "+997 more" counter stands in for the 1000 goroutines of TestAccountConcurrentSafety). At the right, one actor lane containing a single balance cell. In the scaffold scene the balance cell floats in the middle, shared: each caller reads a copy, the copies show the same number at the same instant, and the writes land on top of each other — the loser's write fades out with a "lost" marker while a tally reads expected 103 / shown 102. In the actor scene the cell is drawn inside the actor lane and is visibly unreachable from the caller lanes; every caller holds a request card {op, amount, reply}, and its send arrow only turns solid when the actor takes the card. The actor updates the cell, sends a thin reply arc back to that caller, waits for the caller to receive it, then takes the next card. At any tick exactly one pair moves; everyone else is drawn frozen with a small "blocked" tag on what they are waiting for.

**Scenes.**
1. **Lost update (scaffold)** — Three deposit lanes read the shared cell at the same value in one tick, then each writes back +1. The second write overwrites the first; that lane's write fades and a deficit counter reads 'expected 103, shown 102'. Caption ties it to main.go:67 and to the test's 10836-vs-11000 failure. A small 'no race detector in the browser' note sits beside the read/write pair.
2. **Withdraw with no check (scaffold)** — The withdraw lane runs two operations on the naive account: it never reads the balance before debiting (main.go:73-76). A withdrawal of 2000 is accepted, the cell drops to -880, and `err` is nil. The scaffold's single-step 'check' slot is drawn as an empty dashed box labelled 'missing'.
3. **One request at a time (actor, success path)** — The panel switches to the fixed shape: callers enqueue request cards, the actor takes exactly one, updates the owned cell, replies, and only then takes the next. In the withdraw round of 100 with five 30-withdrawals, the check-and-debit run as one indivisible slice inside the actor: three succeed, two get ErrInsufficientFunds with the cell unchanged, final 10 — the exact numbers of TestAccountWithdrawRejectsInsufficientFunds. A second round runs 1000 deposits with the counter lane and lands on the exact expected total.
4. **Wedge and exit (blocking + lifecycle)** — Two beats behind one scene selector. (a) 'Deposit skips <-reply': the actor sends its reply, no lane receives, the actor freezes, the queued-sender stack grows, and every caller lane turns frozen — caption quotes the test's own message, 'a wedged actor goroutine blocks every future call too'. (b) 'Close vs no Close': close(requests) ends the range loop and the actor lane greys out and exits, the goroutine counter falls 3 to 2; with Close never called the counter stays up and the idle lane sits there forever, matching TestNewAccountStartsActorGoroutineAndCloseStopsIt.

**Controls.** Play / Pause (space); Step one event (right arrow); Restart (home or R); Scene selector: Lost update | No check | Actor | Wedge and exit; Concurrent depositors: 3 / 8 / 1000 (1000 rendered as 3 lanes plus a count); Scene 4 beat: 'Deposit skips <-reply' on/off; Scene 4 beat: 'Close called' on/off; Speed x0.5 / x1 / x2; under prefers-reduced-motion the default is step-only with no auto-advance.

**Annotations.** read 100 / read 100 — two lanes hold the same copy; write 101 overwrites write 101 — lost update; send blocks until the actor receives (caller frozen before the actor takes the card); receive: the actor takes exactly one request; balance lives here — only this goroutine can reach it; reply: the actor blocks until the caller receives; check and debit are one step — no request can land between them; ErrInsufficientFunds, balance unchanged; close(requests) ends the range loop; actor exited (goroutine count 3 → 2); send on a closed channel panics — undefined here by design; missing: no funds check (scaffold); @race would flag this read/write pair — the browser has no race detector.

**Data model.** {"entities":[{"id":"C0..Cn","kind":"caller goroutine","props":{"op":"deposit|withdraw|balance","lane":0,"state":"runnable|blocked-send|blocked-recv|blocked-wedge|done","balanceCopy":null}},{"id":"A","kind":"actor goroutine","props":{"state":"idle|recv|processing|blocked-reply|exited","owns":"balance"}},{"id":"requests","kind":"channel","props":{"buffer":0,"sendQueue":["C0","C3","C1"],"closed":false}},{"id":"reply(Ci)","kind":"channel","props":{"buffer":0,"receiver":"Ci"}},{"id":"balance","kind":"int cell","props":{"value":1000,"owner":"shared(scaffold)|actor"}},{"id":"goroutines","kind":"counter","props":{"value":2}}],"events":[{"t":0,"type":"spawn","actor":"A","note":"NewAccount starts run"},{"t":1,"type":"send","from":"C0","to":"requests","value":{"op":"deposit","amount":1}},{"t":1,"type":"block_send","goroutine":"C0"},{"t":2,"type":"recv","actor":"A","from":"requests"},{"t":2,"type":"unblock","goroutine":"C0"},{"t":2,"type":"read","actor":"A","of":"balance"},{"t":2,"type":"write","actor":"A","of":"balance","value":1001},{"t":3,"type":"send","actor":"A","to":"reply(C0)"},{"t":3,"type":"block_recv","goroutine":"A"},{"t":4,"type":"recv","goroutine":"C0","from":"reply(C0)"},{"t":4,"type":"unblock","goroutine":"A"},{"t":5,"type":"check","actor":"A","amount":30,"balance":100,"result":"ok|insufficient"},{"t":5,"type":"debit","actor":"A","amount":30},{"t":5,"type":"reject","actor":"A","err":"ErrInsufficientFunds","balanceUnchanged":true},{"t":9,"type":"close_chan","goroutine":"C0","channel":"requests"},{"t":10,"type":"exit","actor":"A"}],"scaffold_events":[{"type":"read","goroutine":"C0","of":"balance","value":100},{"type":"read","goroutine":"C1","of":"balance","value":100},{"type":"write","goroutine":"C0","of":"balance","value":101},{"type":"write","goroutine":"C1","of":"balance","value":101,"effect":"lost update"},{"type":"write","goroutine":"C0","of":"balance","value":-880,"note":"no check"},{"type":"result","goroutine":"C0","err":null}],"renderer_contract":"A step is a timestamped array of events; the renderer applies all events at t, then holds until the next step. Every blocked entity carries the reason (send|recv) so the lane can label it. All numbers come from the script, never from wall-clock scheduling."}

**Code anchors.**
- 19-actor-model/main.go:67 — `a.balance = a.balance + amount`, the read-modify-write that races
- 19-actor-model/main.go:73-76 — Withdraw debits with no funds check and returns nil
- 19-actor-model/main.go:78-80 — Balance returns the field directly
- 19-actor-model/main.go:85 — `func (a *Account) Close() {}`, the no-op that the actor version must replace
- solutions/19-actor-model.md:100 — `for req := range a.requests`, the serialization loop (the doc's own band {50} in its code block)
- solutions/19-actor-model.md:92 — `go a.run(initial)` in NewAccount (doc band {42})
- solutions/19-actor-model.md:127 — `<-reply` in Deposit, the drain whose omission wedges the actor (doc band {77})
- solutions/19-actor-model.md:106-110 — the check-then-debit inside one `case opWithdraw`, atomic for free
- solutions/19-actor-model.md:120-122 — `close(a.requests)` ends the range loop
- check_test.go TestAccountConcurrentSafety — 1000 concurrent deposits, exact final balance (the browser cannot show the race, only this number)
- check_test.go TestAccountWithdrawRejectsInsufficientFunds — 5 withdrawals of 30 from 100, at most 3 succeed, balance never negative
- check_test.go TestNewAccountStartsActorGoroutineAndCloseStopsIt and TestAccountCloseStopsActorGoroutine (synctest) — the goroutine-count beat
- check_test.go TestMainDoesNotUseLocks — why the visualisation must never suggest a mutex as the fix

**Verifier corrections — read before building.**
- The browser premise is false. I ran the real wasm runner with `cd web && VERBOSE=1 npm run smoke -- --only 19`; it printed `--- PASS: TestAccountConcurrentSafety`. On GOARCH=wasm, GOMAXPROCS is 1 and async preemption is unavailable, so the read-modify-write at 19-actor-model/main.go:67 cannot be interrupted between the read and the write. The browser learner sees the exact 11000, not `10836`. The lost update is a local `-race` or multi-core event, and the visualisation must say so.
- Scene 2 mixes two code paths. A 2000 withdrawal from main()'s account (19-actor-model/main.go:90-108: 1000 plus 100 deposits equals 1100 in the browser) gives -900, not -880. The value -880 comes from TestAccountBasicOperations (check_test.go:128-134: 120 minus 1000). Pick one path and one amount.
- The goroutine-count beat hardcodes `3 -> 2`. TestNewAccountStartsActorGoroutineAndCloseStopsIt measures before and after (check_test.go:352-369), and the smoke run observed 3 before NewAccount. Show N -> N+1 -> N, or the test's relative assertion.
- The event schema mislabels the actor's reply send as `block_recv`. In the fix the actor blocks in `req.reply <- response{...}` (solutions/19-actor-model.md:104,107,111,113), which is a send. A renderer that labels a blocked lane by its reason will show `blocked on receive`. Use a block event with an explicit `op: send|recv` and a channel field.
- Spoiler safety is conditional, not true as designed. The scene selector offers the fixed-shape scenes with no reveal, so the Visualise tab bypasses the Solution gate at web/src/components/DocPane.tsx:55-68. The reply-drain and Close details are solution-doc material (solutions/19-actor-model.md:173-176). Gate the fixed scenes behind a reveal.
- The third tab does not fit the existing tab bar at narrow widths. `.doc-tabs` is a nowrap flex row (web/src/styles.css:540-558) and the workspace's doc column has a 260px minimum (web/src/styles.css:506). Three tabs plus the difficulty badge and the passed badge overflow; `Visualise` is the longest label. Use a short label and/or let the row wrap.
- The proposal misses the strongest web-mode lesson: the learner's own Run Tests shows TestAccountConcurrentSafety PASS on the scaffold. Opening with a lost update contradicts the runner. Make the browser-versus-local contrast the default scene: browser PASS, then the same code under local `-race` with the lost update.
- The 1000-goroutine compression must not invent `10836`. Use the real constants 10000 plus 1000 equals 11000 for a correct actor, and label 3 lanes plus `x997` as an abstraction. The proposal's `expected 103, shown 102` and its tie to 10836 are a single recorded `-race` run (solutions/19-actor-model.md:31), not a constant.
- The tab needs a registry. The generator reads only `.go`, `.md` and `go.mod` from HEAD (web/tools/gen/main.go:484-487), so it cannot add a `visual` flag to the exercise summary. Use a bundled registry under `web/src/visuals/` and render the tab only for a registered id. Also make `parseRoute` reject `/<id>/visualise` for unregistered exercises.
- The annotation click cannot jump to a line as currently wired. DocPane's `onOpenFile` is `(name: string) => void` (DocPane.tsx:13) and the Markdown file link passes only a name (web/src/markdown.ts:52-53). CodePane's `OpenFile` already accepts `(name, line?, col?)` (CodePane.tsx:13); widen the prop if an annotation should open `main.go:67`.
- TestAccountCloseStopsActorGoroutine is a synctest test (check_test.go:260-270) and does not count goroutines. The count belongs to TestNewAccountStartsActorGoroutineAndCloseStopsIt. The tie in the proposal is slightly wrong.
- The actor scene draws `{op, amount, reply}` as if it were the required shape. The scaffold comment says the request shape is up to you (19-actor-model/main.go:14-16). Label it `one valid shape`, or the animation becomes a spec.
- The proposed left-to-right time axis will not hold three caller lanes, reply arcs and labels at 320px. The doc body gives about 276-288px of content width at 320px (web/src/styles.css:572-576). Use a vertical time axis with lanes as rows and a pending-sender counter, and keep labels at 11.5px or larger.
- The default scene is wrong for this site. The proposal opens with the lost update, which the browser cannot show. The repo rule is to show the scaffold's symptom first. The browser symptom is the negative balance and the missing goroutine (check_test.go:130-134, 358); the lost update is the local symptom.

**Corrected design (use where it conflicts with the design above).**

Placement: add a third `Visualise` tab, rendered only when the exercise id is in a bundled registry. Keep it web-only. A third tab is better than embedding in the Problem tab (which mixes the symptom with the task) or in the Solution tab (which hides the symptom behind the spoiler). The changes are `Route.tab` at web/src/router.ts:6, `parseRoute` at :12, `routePath` at :17, the `ExerciseView` props at ExerciseView.tsx:10, the `DocPane` props at DocPane.tsx:11, and the tablist at DocPane.tsx:26-32. Add `web/src/visuals/index.ts` as a small map from exercise id to a lazy import. Use a short label (`Animate`) and let `.doc-tabs` wrap at narrow widths.

Scenes, in this order:
1. `Browser vs local` (default, scaffold, no spoiler). Show the learner's actual result: TestAccountConcurrentSafety PASSES in the browser, verified with the wasm runner. A toggle `local, with -race` replays the same deposits on a multi-core timeline; two lanes read the same value and one write is lost. Caption: `The browser hides this race; run go test -race locally.`
2. `No funds check` (scaffold, no spoiler). Follow one path only. Use TestAccountBasicOperations: NewAccount(100), +50, -30, then Withdraw(1000). The scaffold returns nil and -880; the fix returns ErrInsufficientFunds and keeps 120.
3. `One request at a time` (fixed, behind a reveal). Callers enqueue cards; the actor takes one, updates the owned cell, replies, then takes the next. Check and debit are one slice. Use the real constants 100/30/5: 3 succeed, 2 reject, final 10.
4. `Wedge` (fixed, behind a reveal). Deposit skips `<-reply`; the actor blocks in the reply SEND; the pending-sender stack grows. Label the block reason `send`.
5. `Close` (fixed, behind a reveal). `close(requests)` ends the range loop; show N -> N+1 -> N. A `no Close` toggle leaves the actor idle forever.

Layout: a vertical time axis. Three caller lanes plus a `x997` counter, one actor lane. Keep labels at 11.5px or larger. Use the CSS variables in web/src/styles.css:1-87 for light and dark. Draw with React, SVG and CSS; add no dependency. Lazy-load each visual module with `React.lazy` and a `Suspense` fallback; the registry is small and bundled.

Controls: Play/Pause (space when the visualisation has focus), Step (right arrow), Restart (Home or R), a scene selector, and speed. Under `prefers-reduced-motion`, default to step-only with no auto-advance (the existing reduce block is at web/src/styles.css:1067-1073). Use real buttons; no hover-only control.

Data: one events array per scene. Each step is a timestamp; apply all events at a step together. Use a `block` event with `op: "send" | "recv"` and the channel name. Add the caption `one valid interleaving, not the only one` wherever order matters. Put the numbers in named constants with comments that cite check_test.go.

Spoiler: scenes 1 and 2 open; scenes 3, 4 and 5 behind a `Show the fixed version` button with the same wording as the Solution tab. State in the tab that the animation is a scripted illustration, not a trace of the learner's code.

**Verifier note.** The verdict stays `high`, but the reason changes. The value is the browser-versus-local contrast and the wedge, not the lost update alone. The exercise is rated `hard` (root README.md:38). The README's ASCII diagram (19-actor-model/README.md:9-18) shows the today-versus-goal shape but not timing, blocking or the wedge, so a motion explainer adds something. The wedge is the one failure mode a learner can hit in the browser and cannot see by reading the code.

Empirical check: `cd web && VERBOSE=1 npm run smoke -- --only 19` printed `--- PASS: TestAccountConcurrentSafety` and `--- FAIL: TestAccountWithdrawRejectsInsufficientFunds`, `TestAccountBasicOperations`, `TestNewAccountStartsActorGoroutineAndCloseStopsIt`. This is the actual wasm runner the site uses. It refutes the proposal's central browser claim and gives the corrected default scene.

Tab versus existing tabs: use a third tab, conditionally. Embedding in Problem mixes the symptom with the task; embedding in Solution hides the scaffold symptom behind the spoiler. A tab also gives a shareable URL. The router change is small (router.ts:6,12,17).

Modes: web only. The clone has no renderer, and the README ASCII diagram is required by the readme-diagram rule (tools/check/lint.go:256-258). The tab is additive and must not become a second source of truth. If the owner wants clone-mode parity, link the exercise README to the site route; do not generate a second diagram.

Spoiler: the default scene is safe, but the proposal's scene selector is not. Gate the fixed scenes, or the tab bypasses the Solution gate at DocPane.tsx:55-68.

Effort `M` is fair: one visual module plus the conditional tab plumbing is more than S and less than L.

**Risks.**
- Ordering is not a language guarantee. Go does not promise FIFO service across contending channel senders, and the solution doc says so explicitly. A lane animation that always shows first-come-first-served teaches a false invariant; the scene must caption 'one valid interleaving, not the only one' and must not label lanes with arrival order as if it were a rule.
- The 1000-goroutine test cannot be drawn lane by lane. Compressing it into 3 lanes plus a counter risks arithmetic that does not match the test's exact numbers; fix the script to the real test constants (10000 + 1000, and 100 with five 30s) rather than invented round numbers.
- Spoiler gate. The third and fourth scenes show the fixed shape. The README already describes that shape, but the wedge and Close beats are the solution doc's 'two correctness details'. If the tab is ungated it bypasses the Solution gate; either keep the default scene at the scaffold symptom and put later scenes behind the same reveal control, or move the wedge/Close beats into the solution doc.
- GOMAXPROCS=1 in the browser runner means a learner who then tries to reproduce the interleaving in their own editor will not see preemption; the hero must say the animation is a scripted illustration, not a trace of their code.
- A third tab is a site-wide change: router.ts's Route.tab union, parseRoute, routePath and DocPane's tablist all assume two tabs. Render the tab only for exercises that have a visualisation, or a 43-row tab bar fills with empty entries.
- 320px width and four lanes: reply arcs and labels will not fit at small sizes, so lay time vertically or let the track scroll horizontally rather than shrinking text below 11.5px.
- The exercise leaves post-Close and zero-value behaviour 'up to you'; the animation must not present one choice (panic on send to closed channel) as the required answer.
- Two representations drift: the README's ASCII today-vs-goal fence is required by the readme-diagram lint rule and is the only version a clone-mode reader sees, so the web animation must be additive and must not create a second, diverging source of truth.
- Reach for a mutex is the natural instinct for most readers; any frame that reads as 'the actor is a lock with extra steps' would fight TestMainDoesNotUseLocks. The wedge scene is the honest counterweight, so keep it.
- Both modes question: this can only exist in web mode. The cloned repo has no renderer, so the README diagram stays as the clone-mode answer and the tab is a web-only upgrade.

**Why this tier.** The browser passes the scaffold, so the lesson is why -race matters; show the lost update a scripted local run finds.

<a id="21-dining-philosophers"></a>
#### 21 — Dining Philosophers: Deadlock Avoidance
`Tier B` · **high** · lock and waiters · family `lock` · effort M · README diagram: yes

**Pattern.** Dining philosophers: deadlock avoidance. Circular wait on two mutexes per goroutine. Fix by resource ordering (lowest fork index first) or by an arbitrator semaphore that admits N-1 goroutines.

**Core idea.** A deadlock is a closed cycle in the wait-for graph: each goroutine holds one fork and blocks on a fork held by the next goroutine. If every goroutine uses one global lock order, the cycle cannot close. Limiting admission to N-1 goroutines also leaves one seat empty, so the ring has a gap.

**What prose and tests cannot show.** The prose states "left then right is wrong", but the learner cannot see the wait-for graph: which fork each goroutine holds, which goroutine blocks on it, and that Lock() parks silently with no error and no panic. The learner also cannot see that the ring is the whole bug, and that the fix changes one edge, not the number of forks. The scaffold's 1 ms Sleep is what makes the ring reliable; deleting it only narrows the collision window, and the 10,000-meal test closes that cheat path.

**Design.** Draw a round table seen from above. Place N seats on a circle, with one fork between each pair of seats. Each fork is a lock node. It shows its holder and a short FIFO queue of goroutines blocked on it. Each philosopher is a small panel with a state word, a meal count, and two fork slots. Draw a waiter edge from a philosopher to the holder of the fork it waits on. In the scaffold, play five beats: every seat locks its left fork, a reaching bar passes, every seat asks for its right fork and parks. The waiter edges close into a ring. The meal counter stays at 0. The test's 3 s timer fires. In the fix scene, seat 4 asks for fork 0 before fork 4. One edge is reversed, so the ring cannot close. One philosopher eats, releases both forks, and wakes a neighbor. The progress moves around the table until all meals are done. A third scene adds a gate that admits only N-1 seats. One seat stays empty. The same held and waiting arrows appear, but the ring has a gap at the empty seat.

**Scenes.**
1. **The ring closes (scaffold, default)** — Five seats and five fork nodes. Every seat locks its left fork in turn; each fork takes the holder's color. A 1 ms reaching bar passes. Every seat then requests its right fork and parks: a blocked badge appears on the seat, and the fork shows its holder. Waiter edges draw seat i to seat i+1 and close into a ring. The meal counter stays at 0 and wg.Wait() pulses. The 3 s timer fires and shows the test failure and the leaked Dine goroutine.
2. **One edge reversed (lock order fix)** — Opt-in after the timeout. Each seat compares its two fork indices and takes the lower one first, so seat 4 reaches for fork 0 before fork 4. Seats 0 and 4 contend on fork 0; one wins, takes its second fork, eats, and releases both. The release wakes a neighbor, and progress ripples around the table. The seat 4 edge is reversed, so no cycle can close. All meals finish and the counter reaches N times meals.
3. **One seat empty (arbitrator fix)** — A gate admits only N-1 seats. The fifth waits at the gate. The admitted seats still hold-and-wait left then right, so single blocked arrows appear, but the empty seat leaves a gap in the ring. Someone always completes and releases, which admits the next seat. A side-by-side compare with scene 1 shows the same arrows minus one edge.

**Controls.** Play / Pause (Space): builds the scene in slow beats, or holds a frame.; Step: advances exactly one event (lock, block, unlock, eat, timeout) and names it in a text log.; Restart: resets the current scene to the first frame.; Per-seat reach order: each seat can reach left first (default) or right first. Opening one edge by hand is the discovery moment.; Show a known fix (opt-in, after the timeout): lower-index-first lock order, or N-1 admission.; Table size: 2, 5, 8, matching TestDineWithVaryingTableSizes.; Reaching pause: on or off, with a note that removing it narrows the window but does not fix the order..

**Annotations.** lock held: the fork is painted in the holder's color and names the holder.; blocked on sync.Mutex.Lock: the goroutine is parked; there is no error and no panic.; waiter queue: the FIFO list of goroutines blocked on one fork.; circular wait: the closed ring of held and waiting edges.; hold-and-wait: one fork is held while the second is requested.; wg.Wait(): Dine's caller stays parked until the last wg.Done().; atomic.AddInt32(mealsEaten, 1): the meal counter that stays at 0 in the scaffold.; time.Sleep(time.Millisecond): the scaffold's reaching pause that makes the ring reliable.; unlock: the fork returns to the free pool and wakes one waiter.; deadlock: every goroutine is durably blocked; the test times out at 3 s.; arbitrator: a buffered channel of N-1 permits, not a fork lock..

**Data model.** Entities: Table {n}; Philosopher {id, state: idle|reaching|holds-first|blocked-on-second|eating|done, held: forkId[], meals, goroutine}; Fork {id, holder: philosopherId|null, waiters: philosopherId[]}; Counter {meals}; Gate (arbitrator scene) {capacity: n-1, inside: philosopherId[]}; WaitEdge {from: philosopherId, to: philosopherId, viaFork, state: held|waiting}. Events, one per step: spawn(p); request(p, fork) -> granted (holder = p) or blocked (push p to fork.waiters, state = blocked-on-second); release(p, fork) -> holder = null and wake the next waiter; eat-start; eat-end -> atomicAdd; gateEnter(p); gateExit(p); waitGroupWait; timerFire(3000); deadlockDetected(cycle: philosopherId[]). Timeline: an ordered array of steps, each {t, event, snapshot}. The snapshot holds the full state after the event, so the renderer draws state and never interpolates the real scheduler. Step mode consumes one step. Play consumes steps at a fixed cadence. prefers-reduced-motion disables Play and keeps Step. No Math.random: the timeline is scripted and replayable.

**Code anchors.**
- 21-dining-philosophers/main.go:63 p.leftFork.mu.Lock()
- 21-dining-philosophers/main.go:70 time.Sleep(time.Millisecond) (the reaching pause)
- 21-dining-philosophers/main.go:71 p.rightFork.mu.Lock()
- 21-dining-philosophers/main.go:77-78 p.rightFork.mu.Unlock(); p.leftFork.mu.Unlock()
- 21-dining-philosophers/main.go:95-96 left := forks[i]; right := forks[(i+1)%numPhilosophers]
- 21-dining-philosophers/main.go:101 wg.Wait()
- solutions/21-dining-philosophers.md:131-133 first, second := p.leftFork, p.rightFork; if second.index < first.index { first, second = second, first }
- solutions/21-dining-philosophers.md:209 arbitrator := make(chan struct{}, numPhilosophers-1)
- solutions/21-dining-philosophers.md:187,199 arbitrator <- struct{}{} / <-arbitrator
- 21-dining-philosophers/check_test.go:70 mealsToEat = 10_000
- 21-dining-philosophers/check_test.go:72 dineWithTimeout(..., 3*time.Second)
- 21-dining-philosophers/check_test.go:87 table sizes 2, 5, 8

**Verifier corrections — read before building.**
- Spoiler safety is false as designed. The default controls include a per-seat reach-order toggle, so a learner can reverse seat 4's edge before the timeout and see the lock-order fix. Gate the toggle behind the same show-a-fix action, or remove it from the default scene.
- The named fix selectors leak the answer. A visible choice labelled lower-index-first or N-1 admission hands over both strategies before the learner reaches the Solution tab. One button named 'Show how one edge breaks the ring' is enough; name the strategy only after the click.
- The 320px geometry is optimistic. web/src/styles.css:506 lets the doc pane shrink to 260px, and the desktop doc-body padding (web/src/styles.css:574, 16px 22px) leaves 216px of content; a 320px phone leaves 288px. The proposed per-seat panels (state word, meal count, two fork slots) do not fit. Use compact nodes and a shared status line.
- A third tab does not fit at the pane minimum. .doc-tabs (web/src/styles.css:540) does not wrap; Problem plus Solution plus the difficulty and passed badges already approach 260px, and a third tab adds about 78px. Put the panel inline in the Problem tab instead.
- The side-by-side compare of scene 1 and scene 3 is impossible at 216-288px. Use a toggle or an overlay that reuses one ring.
- sync.Mutex does not guarantee a FIFO waiter queue. Go's mutex can let a new arrival barge in normal mode. The proposal's 'FIFO list' and Fork.waiters imply an order the runtime does not promise. Say 'waiters, order not guaranteed' or omit the queue.
- The timeline cannot reach the real meal count. check_test.go:70 runs 5 x 10,000 = 50,000 meals, but the fix scene says the counter reaches N x meals. That needs 50,000 events. Animate a scaled model (5 seats x 3-5 meals), label it, and cap the timeline at about 40 events.
- The reaching-pause on/off control cannot be honestly animated. Without the 1ms pause the deadlock is timing-dependent, not deterministic; the test comment says the 10,000-meal loop makes it reliable in practice, not by proof. A scripted timeline cannot show 'narrows the window' as an event. Make it a note, not a toggle.
- A global Space shortcut conflicts with the Monaco editor beside the doc pane (web/src/components/CodePane.tsx). Scope Space to the visualisation when it has focus; use native button activation otherwise.
- aria-live on the event log will flood a screen reader during Play. Announce on Step only, or set aria-live='off' during Play.
- There is no holder palette. web/src/styles.css:1-28 has only accent, pass, fail and difficulty tokens. Five holder colours need new light/dark variables and a non-colour cue (letter or shape), because colour alone fails WCAG 1.4.1.
- The concept contradicts its own visual-form reason. It rejects 'a state machine per philosopher needs N panels', then specifies 'each philosopher is a small panel with a state word, a meal count, and two fork slots'. Use compact seat nodes.
- The effort rating is optimistic. Three scenes, three table sizes, a per-seat order sandbox, a pause toggle, two fix engines, a side-by-side compare, a legend and a responsive fallback are L, not M. Ship the scaffold and lock-order scenes only. The 8-seat table size is unreadable at 216px; cut it.
- Several scene facts are schedule-specific, not universal. The counter is not always 0 when the ring closes; seat 0 can block on F1 even under the lock-order fix (the first meal comes from the highest-index seat); the test leaks Dine plus five philosopher goroutines, not one; the 3s timeout is the main test, while check_test.go:90 uses 2s. Label the schedule and the test.
- The generator needs no change only if the visualisation is a web/src/viz/ registry with a static id -> import() map. web/tools/gen/main.go:485 reads only .go, .md and go.mod from HEAD, so per-exercise scene data in the JSON would need a generator change.
- Clone mode is web only, and that is right. Do not add an SVG or GIF to the README: tools/check/lint.go:154 forbids non-.md files in an exercise folder, and the generator drops them. The ASCII ring at 21-dining-philosophers/README.md:13-19 is the clone-mode visual.

**Corrected design (use where it conflicts with the design above).**

Placement and scope: put the visualisation in the Problem tab as a collapsed panel named 'See the ring form', below the Markdown and above the pager. Do not add a third tab. Keep the Solution tab and its spoiler gate unchanged. Web only: the clone workflow keeps the ASCII ring in 21-dining-philosophers/README.md:13-19; do not add a file to the exercise folder.

Loading: add web/src/viz/registry.ts with a static map id -> () => import('./21-dining-philosophers.tsx'). Render the panel only for exercise 21 after the import resolves. The per-exercise JSON and web/tools/gen/main.go stay unchanged.

Form: one SVG ring with a responsive viewBox. Five seat nodes (P0..P4) and five fork nodes (F0..F4) on the circumference. A waiter edge runs seat i -> seat i+1. A held fork takes the holder's label; a blocked seat gets a lock glyph and the word 'blocked'. Under the ring, show one shared status line, one meal counter and one log line. Do not draw a panel per seat. Below about 300px pane width, switch to a linear fallback: the README's five rows (P0 holds F0, wants F1 -> held by P1) with the same live state, so the panel works at 216px.

Scenes, v1: (1) Scaffold: five seats, three meals as a scaled model. Step spawn, left locks, the labelled 1ms pause, right requests, block events, the closed ring, the frozen counter, 'Dine is parked in wg.Wait()'. End with a caption that quotes the failure text at check_test.go:72 and says this is the schedule the 1ms pause makes repeatable, while the test uses 10,000 meals. Cap the timeline at about 40 events. (2) Lock order: behind one button, 'Show how one edge breaks the ring', after the timeout. Each seat takes the lower-index fork first. Show the free end of the chain at the highest-index seat, then the ripple of eats and releases. The counter climbs to the model's total. Do not name lower-index-first or N-1 admission before the click. Drop for v1: the arbitrator scene, the 2/5/8 selector, the pause toggle and the per-seat order sandbox. Add the arbitrator scene later only if the budget holds.

Controls: real buttons for Play/Pause, Step and Restart. Space toggles play only when the visualisation container has focus. Step advances one event and names it. Restart resets the scene. With prefers-reduced-motion, start in Step mode and disable Play with a note. Use aria-live='polite' on the log only in Step mode; leave it off during Play. Nothing needs hover.

Accuracy and theme: do not draw a FIFO waiter queue; Go's sync.Mutex can barge, so say 'waiter' with no order. Label the schedule as one possible schedule. Show the test timeout as a replay caption, not a real timer. The model has three meals, not 10,000. The leak is six goroutines (Dine plus five philosophers). The 3s timeout is the main test; check_test.go:90 uses 2s. Add five --viz-holder-* tokens with light and dark values, and pair each with a letter or shape so colour is not the only cue.

**Verifier note.** Empirical check: I copied the HEAD main.go and check_test.go into a temp module and ran GOMAXPROCS=1 go test -run TestDineCompletesWithoutDeadlock. It failed at 3.00s with the exact t.Fatalf text at check_test.go:72. The scaffold really fails as described. The README already draws the ring at 21-dining-philosophers/README.md:13-19, so the animation is not 'must'; the high tier stands on the ring formation and the one-edge break, not on the proposal's claim that the learner 'cannot see the wait-for graph'. The tier is unchanged. The proposal is wrong that spoiler_safe is true: the default per-seat reach-order control is the lock-order fix in miniature, and the named fix selectors leak both strategies. The approach is feasible with no new dependency, but not as written: the doc pane can be 260px (216px of content), the tab row overflows with a third tab, and the scope is L, not M. User questions: (1) put it in the Problem tab as an inline collapsed panel, not a third tab; (2) web only; the clone workflow keeps the ASCII ring.

**Risks.**
- Determinism vs. truth: the scaffold's ring depends on the 1 ms Sleep and the 10,000-meal loop. Without the Sleep the deadlock is timing-dependent, not guaranteed. Label the pause and say that deleting it only narrows the window; the explainer is scripted, not a trace of the learner's code.
- Spoiler leak: the sorted-order and arbitrator scenes must sit behind an opt-in action after the timeout. A visible selector named 'lowest index first' hands over the answer before the learner sees the failure.
- 320 px geometry: five seats, five forks, arrows, and a control bar do not fit with long labels. Use an SVG viewBox that scales to the pane width, 16 px gutters, short labels (P0, F0), and a text event log below for readers who cannot use color.
- Accessibility: everything must work from the keyboard with no hover. Use real buttons, an aria-live event log, and a step-only mode when prefers-reduced-motion is set.
- Placement: a third tab fits best. Inline in Problem interrupts the prose and pushes the test instructions away, and the Markdown body re-renders its innerHTML. Inline in Solution puts the spoiler-free symptom behind the spoiler gate. A /<id>/visualisation route keeps the symptom before the solution and lets the component load per exercise.
- Mode scope: web only. The clone workflow has no UI, and the lint layout rule forbids new files in an exercise folder. The committed README's ASCII ring already serves the clone reader, so do not add an SVG or GIF there.
- Scope creep: the arbitrator scene needs a second strategy engine. Ship the scaffold and lock-order scenes first; add the arbitrator scene only if the budget holds.

**Why this tier.** The wait-for cycle: five holders, five waiting edges, a closed ring; one reversed edge breaks it.

<a id="22-circuit-breaker"></a>
#### 22 — Circuit Breaker: Protecting a Flaky Payment Gateway
`Tier B` · **high** · state machine · family `state` · effort M · README diagram: yes

**Pattern.** Three-state circuit breaker (CLOSED → OPEN → HALF-OPEN) guarding a flaky downstream call, with one mutex-protected compound transition and a single half-open trial slot.

**Core idea.** A breaker is a tiny state machine that remembers consecutive failures and a cooldown deadline, so a failing downstream stops receiving traffic; every transition must be atomic, but the slow downstream call must stay outside the lock.

**What prose and tests cannot show.** Two runtime effects that prose and test names cannot show. First, if the breaker holds its mutex across gateway.Charge, it serializes every caller in the CLOSED state, and during a HALF-OPEN trial the other callers queue on cb.mu instead of returning ErrCircuitOpen at once. Second, many callers can arrive at the OPEN → HALF-OPEN boundary in the same instant, and exactly one may claim halfOpenInFlight. The tests assert both with wall-clock durations (two closed calls under 1.5× a 150 ms delay; a second caller rejected in under 75 ms), and those numbers look arbitrary until the lanes and the lock are drawn.

**Design.** A horizontal timeline fills the doc pane. On top sits a row of three state pills, CLOSED, OPEN, HALF-OPEN, with the active one lit in --accent and the others in --fg-muted. Beside them sits a failure counter ("consecutive fails 3 / 5") and, while OPEN, a countdown bar from 2 s to 0. Below the pills, one short lane per caller runs left to right: a token for the goroutine, an optional padlock icon for the breaker lock, and an arrow into a gateway box on the right. A green token returns a check; a red token returns ErrGatewayDown and bumps the counter. In OPEN, tokens stop at a gate before the gateway and return a short ErrCircuitOpen arrow; the gateway box turns grey and its call counter freezes. When the cooldown bar empties, HALF-OPEN lights and one token gets a key icon for the single trial slot; a second token at the same instant is turned away at the gate. The trial's outcome either clears the counter and returns to CLOSED, or flips back to OPEN and refills the bar. A buggy variant draws the padlock on the first caller's lane across the gateway call, and later tokens stack as waiters behind it. Everything is drawn from a precomputed event log, so the same picture works with motion off, one event per Step.

**Scenes.**
1. **Naive pass-through (today)** — The gateway is failing. Six callers arrive one after another, each token crosses the whole lane into the gateway box, and each returns red ErrGatewayDown. gateway.Calls() climbs 1 → 6. The three state pills sit grey and inert, the failure counter stays empty, and ErrCircuitOpen never appears. The learner sees the cost of a breaker that remembers nothing: a dead downstream takes every call.
2. **Trip and fail fast** — Five red calls climb the counter 1/5 … 5/5. On the fifth, CLOSED flips to OPEN and the 2 s cooldown bar starts to drain; the gateway box greys out. The sixth caller is diverted before the gateway into a short return labelled ErrCircuitOpen. gateway.Calls() freezes at 5 while more callers arrive and are rejected. The contrast with scene 1 is the lesson.
3. **Trial, success and trial failure** — The cooldown bar reaches zero. The next caller flips OPEN to HALF-OPEN and takes the single trial slot (a key icon on the pill); a second caller arriving at the same instant is rejected at the gate, not queued behind the trial. The trial lane crosses the gateway: a green result closes the breaker with the counter at 0 and releases the slot; a red result re-opens it, restamps openedAt and refills the cooldown bar from 2 s. A gateway health toggle flips the outcome, so both endings play from the same scene.
4. **Lock scope (after the reveal)** — Two callers with a 150 ms gateway delay. The correct breaker shows two lanes overlapping and finishing near 150 ms. Toggle the buggy variant and a padlock appears on the breaker: the first lane holds it through Charge while the second waits in the cb.mu queue, so the pair finishes near 300 ms. Repeat at the HALF-OPEN boundary: the buggy second caller blocks on the lock instead of returning ErrCircuitOpen immediately. This is the picture behind the two wall-clock assertions.

**Controls.** Play, Pause, Step, Restart: keyboard-first; Step advances one event, so reduced-motion users get the same lesson with no animation.; Gateway failing / healthy: drives the trip and decides the trial's outcome.; Skip the 2 s cooldown: jumps to the OPEN → HALF-OPEN edge and teaches that the cooldown is a deadline, not a sleep.; Add a second caller at the same instant: tests the single trial slot and the fail-fast path.; Gateway delay 0 ms / 150 ms: turns serialization into visible lane overlap versus a waiter queue.; Inject one success in the CLOSED state: shows that the counter resets to 0, not merely pauses.; Lock scope, correct / held across Charge (behind the solution reveal): shows why the two timing tests exist..

**Annotations.** no state kept: every call passes through (scaffold); gateway.Charge(amount): 150 ms of blocking; cb.mu.Lock() / cb.mu.Unlock() around bookkeeping only; gateway call made outside the lock (reveal only); blocked on cb.mu (waiter queue, buggy variant only); consecutiveFails 4 → 5; 5 consecutive failures → stateOpen; openedAt = now; time.Since(openedAt) < cooldownPeriod → ErrCircuitOpen; OPEN: fail fast, gateway not called; gateway.Calls() frozen at 5; HALF-OPEN: halfOpenInFlight = true, one trial only; second caller: ErrCircuitOpen in under 1 ms, does not wait for the trial; trial fails → stateOpen, openedAt restamped (cooldown restarts); trial succeeds → stateClosed, consecutiveFails = 0.

**Data model.** Entities: Caller{id, lane, status: arriving|atGate|inGateway|waitingOnLock|returning|done, result}. Breaker{state: closed|open|halfOpen, consecutiveFails, openedAtMs, cooldownRemainingMs, halfOpenInFlight, lockHeldBy, waiters[]}. Gateway{failing, delayMs, calls}. Clock{nowMs}. Events, each at an integer logical millisecond: caller.spawn, call.arrive, lock.acquire{caller}, lock.release{caller}, allow.pass{caller}, allow.reject{caller}, gateway.enter{caller}, gateway.exit{caller, error}, counter.inc{value}, counter.reset, state.change{from, to, trigger}, cooldown.start{2000}, cooldown.expire, trial.claim{caller}, trial.release{caller}, caller.return{caller, error}, note{text}. Every event carries an immutable snapshot of all entities after it. A scene is a precomputed event log with a cursor; the renderer draws snapshots and derives no Go semantics. Timeline: scene 1 and 2 space calls 400 ms apart; scene 3 uses the real 2000 ms cooldown and 150 ms calls; scene 4 starts two calls at t=0. Playback maps 2000 ms of logic to about 1200 ms on screen; Step moves one event; motion-off mode uses the same log.

**Code anchors.**
- 22-circuit-breaker/main.go:55-57: the scaffold's CircuitBreaker holds only gateway, so scene 1 has no state, counter or deadline to draw.
- 22-circuit-breaker/main.go:68-70: Execute is a bare pass-through to cb.gateway.Charge; scene 1 animates exactly that line.
- 22-circuit-breaker/main.go:51: ErrCircuitOpen is declared but never returned; scene 1 shows it never appearing.
- 22-circuit-breaker/mockgateway.go:64-79: Charge counts the call before sleeping, so the on-screen gateway.Calls() freezes at the moment fail-fast starts working.
- solutions/22-circuit-breaker.md:110-118: Execute calls allow(), then Charge, then afterCall, so the lock is released before the slow call; scene 4 draws this.
- solutions/22-circuit-breaker.md:123-153: allow() makes the OPEN → HALF-OPEN transition and the halfOpenInFlight claim under one lock; scene 3 draws the single trial slot.
- solutions/22-circuit-breaker.md:155-181: afterCall() closes on a successful trial and re-opens with a new openedAt on a failed one; scene 3 draws both endings.
- 22-circuit-breaker/check_test.go:155-180: TestCircuitClosedDoesNotSerializeOnGatewayCall asserts two calls take less than 1.5× the 150 ms delay; scene 4 makes the 150 vs 300 ms difference visible.
- 22-circuit-breaker/check_test.go:193-240: TestCircuitHalfOpenTrialFailsFastForOthers asserts the second caller returns ErrCircuitOpen in under 75 ms; scene 3 and scene 4 show why.
- 22-circuit-breaker/check_test.go:104-150: TestCircuitHalfOpenRecovery walks OPEN → HALF-OPEN → CLOSED under synctest's fake clock; scene 3 is that walk.

**Verifier corrections — read before building.**
- Verdict is overstated as must. The ungated scenes restate the README's own three-state ASCII diagram and the comments already visible in check_test.go; the only content prose cannot express (lane overlap, a waiter queue on cb.mu) is one scene behind the reveal. The exercise is teachable today, so must is wrong; high is the honest tier.
- spoiler_safe: true holds only if the lock-scope scene is gated. Scene 3 also teaches a rule the README does not state for HALF-OPEN: that other callers get ErrCircuitOpen immediately instead of waiting for the trial. Either gate scene 3 too, or add that sentence to 22-circuit-breaker/README.md (which also keeps clone mode equivalent).
- The concept text lets the state pill flip when the cooldown bar empties. The reference solution transitions OPEN to HALF-OPEN lazily inside allow() (solutions/22-circuit-breaker.md:131-139): with no caller, the state must stay OPEN past the deadline, and only the next caller flips it and claims the slot. Drawing a timer-driven flip would teach the wrong implementation.
- Router is not a one-line change: parseRoute maps every second segment except 'solution' to problem (web/src/router.ts:10-12), so /22-circuit-breaker/visualise would silently land on Problem. The Route tab union, routePath, DocPane props (DocPane.tsx:11) and ExerciseView props (ExerciseView.tsx:10) all need the new value, and the tab must render only when a static hasViz(id) registry says so, or every exercise accepts the URL.
- revealed is local useState in DocPane.tsx:17. A third tab that shares the spoiler gate must lift that state or receive it as a prop; otherwise the visualisation gate and the Solution gate diverge.
- The width target is understated. The doc pane can shrink to 260px (web/src/styles.css:507, minmax(260px, var(--doc-frac))), and .doc-tabs (line 540) does not wrap. Problem + Solution + Visualise plus the difficulty and passed badges overflows there. Add overflow-x:auto or a short label, and design at 260px (about 216px after doc-body padding), not 320px.
- Seven controls plus four transport buttons is too much chrome for 216-276px. Collapse the scenario knobs into one Scenario select and one variant toggle; keep transport separate.
- Reduced motion: needs_motion true is fine, but the design never says playback starts paused. It must start paused (no autoplay), read matchMedia('(prefers-reduced-motion: reduce)'), and pause on visibilitychange.
- Keyboard access is necessary but not sufficient. The per-event annotation needs an aria-live='polite' status line, and the new tab should follow the existing role=tab/aria-selected pattern; if tabpanel semantics are added, add them to all three tabs.
- Colour alone carries state (green token = check, red = failure, accent = active pill). Add an icon and a word to each token and a textual 'active' marker on the pill for colour-blind readers in both themes.
- Scenario toggles that mutate a running log would break the design's own rule that the event log is the only source of truth. Each toggle must call a pure buildScene(scene, opts) and restart at event 0.
- Nothing enforces the event-log invariants. Add a node check like web/scripts/smoke-test.ts asserting: at most one trial.claim between trial.releases, gateway.calls never increases while OPEN, the counter never exceeds 5, and the cooldown is monotonic.
- Effort M is understated for player + reducer + 4 scenes + 7 controls + routing + gating + a11y + styles; the corrected scope is L, or M only after the cuts below.
- The analyst's line citations check out at the load-bearing spots (main.go:51, 55-57, 68-70; mockgateway.go:64-79; solution 110-118, 123-151, 155-181; tests 104-138, 155-179, 193-238). Three ranges overshoot into a blank line or the next test's comment (123-153, 104-150, 193-240); harmless, but fix them if used as anchors.

**Corrected design (use where it conflicts with the design above).**

Keep the third-tab placement and the state-machine form; change the mechanics and the scope.

TAB AND ROUTE. Label it "Visualise" and render it only when a static web/src/viz/registry.ts maps the id to a literal import() (Vite only code-splits literal calls; do not build the path from a template string). Extend Route["tab"] to problem | solution | visualise; parseRoute validates the registry and falls back to problem; routePath emits /id/visualise. Lift revealed out of DocPane so the Solution tab and the gated scene share one gate. Build the player as a reusable shell (web/src/viz/Player.tsx) so later exercises reuse it; exercise 22 supplies only its scene data, so the cross-cutting route and gate changes pay off.

SCENES: three, not four. (1) Pass-through, default and ungated: six calls, all ErrGatewayDown, gateway.Calls() 1 to 6, pills inert. (2) Trip, cooldown, trial, ungated: counter 1 to 5, OPEN, a numeric countdown (bar plus "2.0 s" text), gate rejection, Skip; when the bar empties the pill STAYS OPEN so the lazy transition is visible; the next caller flips to HALF-OPEN and claims the slot, a second caller at the same instant is rejected at the gate, then a Fail/healthy toggle (which rebuilds the log) plays trial success to CLOSED or trial failure to OPEN with a restamped deadline. (3) Lock scope, behind revealed: correct vs buggy variant; two lanes overlap at about 150 ms versus a padlock and waiter queue at about 300 ms; at the half-open boundary the correct caller rejects at once and the buggy one waits on cb.mu. Fold the analyst's scene 3 and scene 4 trial-boundary halves into one scene pair.

EVENT LOG. One pure buildScene(scene, opts) returns events at logical milliseconds, each with an immutable snapshot; the renderer reads snapshots only. Add a node invariant check to the npm scripts.

CONTROLS. Transport Play/Pause/Step/Restart (start paused), one Scenario select, one Variant toggle (scene 3 only), one Fail/healthy toggle, Skip while OPEN. All buttons with aria-labels and 32px targets.

LAYOUT. State row wraps to two lines (pills; counter and countdown). Callers are rows with a 44px gateway column. SVG scales inside 216px with no horizontal page scroll, and the player has a fixed min-height so stepping does not reflow the article.

THEME AND A11Y. CSS variables only. Every token carries an icon and a word. aria-live="polite" announces the current event. prefers-reduced-motion defaults to Step and disables transitions.

README. Add one sentence that in HALF-OPEN the other callers fail fast with ErrCircuitOpen, so clone mode carries the same information as ungated scene 2.

**Verifier note.** VERIFIED FROM HEAD. The scaffold's Execute is a bare pass-through (22-circuit-breaker/main.go:68-70), ErrCircuitOpen is declared but never returned (line 51), and main() makes six calls against a failing gateway and prints gateway.Calls() = 6 (lines 72-84). Scene 1 is accurate. The solution doc records the real failure run: threshold, half-open recovery and trial-fail-fast fail; the serialization test passes on the scaffold because it holds no lock. So scene 3 is honestly a hypothetical buggy fix, not the scaffold's symptom.

VALUE CHECK. The README already carries the three-state ASCII diagram, so redrawing the states adds nothing. The unique value is concurrency: lane overlap and waiters on cb.mu. That is one gated scene, which is why the tier drops from must to high.

USER'S TWO QUESTIONS. (a) Tab versus inline: a third tab is the better default because it gives one player, one gate and a stable viewport. The cheaper fallback, with no router change, is scene 1 inline in the Problem tab and scenes 2-3 inline in the Solution tab after the reveal. (b) Clone and web modes: web-only is correct. The clone mode's artifact is the README diagram and a second renderer would be duplicate code; keep the README informationally complete instead.

CONSTRAINTS. No new dependency is needed: inline SVG/HTML plus the existing CSS variables covers it. A literal per-id dynamic import satisfies lazy loading. The lint layout rule forbids new files inside 22-circuit-breaker/; all code lives under web/src/, and the generator needs no change because it reads only exercise .go/.md files from git HEAD.

**Risks.**
- Web-only by construction. The clone mode has no renderer, so this feature is not needed in both modes. The README's fenced state diagram remains the offline equivalent. Do not write a second implementation; if the lock-scope lesson must reach clone users, it stays in the solution doc prose, where it already is.
- Spoiler leakage: scene 4 is the fix. It must sit behind the existing Solution reveal; otherwise the tab answers the hardest design question for the learner.
- If the renderer recomputes state from sparse snapshots instead of replaying the precomputed event log, it can drift from the Go code, for example by admitting a trial while halfOpenInFlight is set. The event log must be the only source of truth.
- Compressed time can misread: a draining 2 s bar looks like a progress animation, not a deadline. Show a numeric countdown and offer Skip.
- A wrong-lock variant that merely looks slower can read as a microbenchmark. Draw the waiter queue and the lane overlap; do not invent timing numbers.
- At 320 px, three pills, a counter, a countdown and lanes compete for width. Stack the state row above the lanes and keep each caller a single short token.
- A third tab touches the route model: router.ts parseRoute maps any second segment other than 'solution' to problem, and DocPane switches on a two-value union. Both need the new value, and the tab strip must keep role=tab semantics and a sane keyboard order.
- No generator change is needed if the scene data lives under web/src and is loaded with a per-id dynamic import; do not put scene files in the exercise folder, which the layout rule forbids.
- The README already contains the three-state diagram, so a scene that only redraws it adds nothing. The value is time, callers and the lock, so the default scene must show the scaffold's six calls.

**Why this tier.** A state machine with a single trial slot; lock scope decides whether the gateway is called once or twice.

<a id="27-heartbeats"></a>
#### 27 — Heartbeats: Detecting a Stalled Worker Before It's Too Late
`Tier B` · **high** · timeline · family `lanes` · effort M · README diagram: yes

**Pattern.** Heartbeat liveness detection. A worker emits progress-coupled pulses on a channel. A watcher runs a select over heartbeat, results and a watchdog timer, and resets the timer on every sign of life.

**Core idea.** A timer that resets on every heartbeat or result tells "slow" apart from "wedged". One flat deadline for the whole job cannot do this. It must be longer than the healthy job and shorter than stall plus one pulse window. The scaffold's 1.5s deadline is too short for the 2.0s healthy job and too late for the stall at 0.8s+0.3s.

**What prose and tests cannot show.** The learner cannot see time, so the two failures stay abstract. In the scaffold, DoWork sends one pulse at t=0 and never again, because checkIn is a no-op (main.go:103). WorkWithTimeout arms one timer for 1.5s and never resets it (main.go:140). The failures pull in opposite directions: the healthy 2.0s job is killed at 1.5s, and the stall that starts at 0.8s is caught at 1.5s, 700ms late and outside the 1.3s test bound. The learner also cannot see that a ticker-driven pulse would keep ticking through a stall and hide it. A timeline shows the reset cadence, the silence, and both misses.

**Design.** Two lanes share one vertical time axis, because 320px cannot show a 2s horizontal axis with 100ms ticks at a readable width. Time flows down. The left lane is the worker: five 400ms unit blocks. Each healthy block carries a pulse tick every 100ms and a result marker at its end. The stalled block has no ticks and runs into a labelled axis break marked "24h". The right lane is the watcher: one bar of width perPulseTimeout that starts at the current time. Every heartbeat or result restarts the bar. When the bar reaches its end, a red line drops across both lanes and a caption reads "error" or "results closed, nil". In the scaffold the bar is armed once at 1.5s and never restarts, and the worker lane shows one lone tick at t=0. Scrubbing the cursor moves a horizontal playhead; each event highlights its tick, marker or bar. At 320px the labels sit above their lanes and stay in the flow, never inside the SVG.

**Scenes.**
1. **Scaffold, healthy job** — Five healthy units finish at 2.0s, but one flat bar set to 1.5s ends first. The worker lane has one tick at t=0 and no other pulse. The run returns [0 1 2] and an error at 1.5s. A healthy job dies. This is the default scene.
2. **Scaffold, stall at unit 2** — The worker goes silent at 0.8s. The flat bar still runs to 1.5s: 700ms late and past the test bound marker at 1.3s. The error returns with only [0 1]. The stall is caught by luck, not by the heartbeat.
3. **Fixed, healthy job** — The checkIn pulse fires at 100ms steps inside every unit. Every pulse and every result restarts the watchdog bar, so it never ends. The job passes 1.5s and finishes at 2.0s with all five results and a nil error. The false positive is gone.
4. **Fixed, stall at unit 2** — The last sign of life is result 1 at 0.8s. The stalled SimulateUnit calls checkIn never, so no tick appears. The bar starts at 0.8s and ends at 1.1s. The red line and the error land 300ms after the silence, inside the test bound.

**Controls.** Transport: play, pause, step, restart, and speed. Space toggles play. Left and right arrows step. Home restarts.; Source: scaffold or worked fix. The fix scenes sit behind a spoiler button that mirrors the existing Solution gate.; Stall unit: none, 0, 1, 2, 3 or 4. Moving it shows that the stall time is when the last sign of life stops.; perPulseTimeout: 150, 300 or 500ms. The watchdog bar changes length; the flat deadline stays perPulseTimeout times workUnits.; workUnits: 3 or 5. This shows why the flat deadline is sized off the whole job (900ms or 1.5s).; Pulse source: checkIn-coupled or independent time.Ticker. The ticker keeps ticking during the stall, so the watchdog never fires. This demonstrates the anti-pattern..

**Annotations.** checkIn() sends on hb (fixed); one startup pulse, then silence (scaffold); hb buffered cap 1: the lone send completes with no reader (scaffold); SimulateUnit stall path: no checkIn, so no pulse; time.After(perPulseTimeout * workUnits): armed once, never reset (scaffold); timer.Reset(perPulseTimeout) on heartbeat; timer.Reset(perPulseTimeout) on result; timer.C fires: the only stall signal; results closed, so return nil; done closed, so the worker exits and does not leak; select takes whichever channel is ready; test bound: stall start + perPulseTimeout + 2*workerPulseInterval.

**Data model.** A pure TypeScript module, web/src/viz/heartbeats.ts, exports buildScenario(input) for four scenarios. It returns data only, with no timers. Constants PULSE_MS=100, UNIT_MS=400, STALL_MS=24h and DEFAULT_TIMEOUT_MS=300 mirror main.go and mockworker.go. Entities: worker goroutine, watcher goroutine, channels heartbeat (cap 1 in scaffold, 0 in fix), results, done, and the watcher's time.Timer. Event union, each with t in simulated ms, lane, kind and label: spawn, unitStart(i), checkIn(i), sendHeartbeat, recvHeartbeat, sendBlocked, sendResult(i), recvResult(i), timerArm(d), timerReset(d), timerFire, stallBegin(i), stallEnd, closeResults, closeDone, returnErr, returnOK, exit. A Scenario has id, mode (scaffold|fix), workUnits, stallAfter, perPulseTimeout, a sorted events array, endT, outcome {results, err} and markers [{t, label, kind:"testBound"}]. The builders are deterministic and unit-testable. The renderer is a pure function of (scenario, cursor): it draws only events with t <= cursor, plus the active timer bar from its last arm or reset to cursor. Scenes 1 and 2 use time.After semantics; scenes 3 and 4 use Reset semantics.

**Code anchors.**
- 27-heartbeats/main.go:82 — hb := make(chan struct{}, 1): buffered only so the lone startup send does not block
- 27-heartbeats/main.go:92-96 — the single startup pulse
- 27-heartbeats/main.go:103 — checkIn := func() bool { return true }: the no-op that makes the heartbeat decorative
- 27-heartbeats/main.go:140 — time.After(perPulseTimeout * time.Duration(workUnits)): one flat deadline, never reset
- 27-heartbeats/main.go:144-155 — the select that reads only results and timedOut
- 27-heartbeats/main.go:128 — SetStallUnit(stallAfter) wires the scenario knob
- 27-heartbeats/mockworker.go:16 — UnitDuration = 400ms
- 27-heartbeats/mockworker.go:69-79 — stalled path: one 24h timer, checkIn never called
- 27-heartbeats/mockworker.go:97-101 — checkIn called between pulseInterval slices
- 27-heartbeats/check_test.go — TestStallDetectedPromptly: deadline stallStartsAt + testPerPulseTimeout + 2*workerPulseInterval
- solutions/27-heartbeats.md:136-143 — checkIn sends on hb and selects on done
- solutions/27-heartbeats.md:186-204 — one time.Timer, Reset on heartbeat and on result, timer.C returns the error

**Verifier corrections — read before building.**
- Scenes 1 and 2 state the wrong return value. Both timeout paths return nil results: 27-heartbeats/main.go:153 and solutions/27-heartbeats.md:202. I ran the HEAD scaffold in a temp module with go1.25.6: healthy and stall runs both give `res=[] isNil=true`. Scene 1's `[0 1 2]` and scene 2's `[0 1]` are the collected-then-discarded slices. The data model must use `outcome.results = null` on timeout, or add a separate `collected` field.
- spoiler_safe is not honest as written. The control `Pulse source: checkIn-coupled or independent time.Ticker` and annotations such as `timer.Reset(perPulseTimeout) on heartbeat` name the fix. If the Problem-tab instance exposes them, the default scaffold scene is not the only content and the fix is revealed without the Solution gate.
- `problem-inline` has no insertion point today. DocPane renders the README wholesale (web/src/components/DocPane.tsx:53-58, web/src/components/Markdown.tsx:66). A custom fence in the README would render as a code block on GitHub and would edit an exercise file. Use a fixed slot in DocPane, selected by a client-side registry; the generator cannot carry the flag because it reads only .go, .md and go.mod (web/tools/gen/main.go:484-487).
- The independent-ticker anti-pattern cannot be modeled inside DoWork's own select. SimulateUnit blocks the worker goroutine (27-heartbeats/mockworker.go:82-94), so a same-goroutine ticker cannot tick during the stall; the control would show the opposite of the intended lesson. Model an explicit out-of-band `go pulseLoop()` and label it as such.
- The test plan risks a new dependency. web/ has no JS test runner, and adding vitest or jest breaks the no-new-dependency constraint. Node here is v22.22.0, with built-in `node --test` and default TS type-stripping (the repo already runs `node scripts/smoke-test.ts`), so a node script or `node --test` is enough.
- Effort M is optimistic if all four scenes and six controls ship. The event union (~20 kinds) + SVG renderer + keyboard handling + tests is closer to M-L. The perPulseTimeout and workUnits knobs mostly repeat arithmetic and multiply layout states at 320px. Trim to transport, stall unit, and a gated source switch.
- CSS variables cannot theme SVG presentation attributes; `fill="var(--x)"` is invalid. Use CSS classes or `style={{ fill: ... }}`, and reuse --fg, --fg-muted, --border, --accent, --fail, --bg-sunken.
- At 320px, a 300ms bar on a 2s axis is about 15% of the track. Set a pixels-per-ms scale with a minimum tick spacing (100ms ticks at least ~6px apart), or the watchdog bar and its resets are hard to read.
- Scene 4's caption `results closed, nil` is wrong for the stall path. The watcher returns nil, error and closes done; results close only because the worker exits (27-heartbeats/main.go:86, solutions/27-heartbeats.md:168-169).
- The README diagram is already rendered inside the Problem tab (27-heartbeats/README.md:14-28). Scenes 3-4 restate it and the solution doc; scenes 1-2 are the differentiator. Build scenes 1-2 first and gate the fixed scenes. A cheaper first step is to add the flat-deadline lane to the README diagram, which reaches both modes.
- The 1.3s test bound applies only to the stall scenes. Scene 1's healthy run is judged by the no-stall test, which only requires completion; its marker should say that, not reuse the stall bound.

**Corrected design (use where it conflicts with the design above).**

Keep the proposal's two product answers. Render in the Problem tab inline, not in a third tab. Build it for the web app only.

Placement: add a slot to DocPane between the topics chips and the Markdown in the Problem tab. Render `<ExerciseViz id={id} mode="scaffold" />` from web/src/viz/registry.ts, a map from exercise id to a React.lazy component, so only exercise 27 downloads the chunk. A third tab would change router.ts (Route.tab at line 6, parseRoute at 12, routePath at 17) and needs a per-exercise opt-in that the HEAD-only generator cannot supply. Do not edit the exercise README, the generator, or a markdown fence.

Solution tab: render the same component in fixed mode inside the existing reveal branch (DocPane.tsx:57-68). Reuse that gate; add no second spoiler button. Do not expose fix-naming controls or annotations in the Problem-tab instance.

Modes: web only. The cloned repo has no renderer, and tools/check/lint.go:154-155 forbids new files in an exercise folder. The README ASCII diagram and the solution doc remain the local explanation.

Data: keep web/src/viz/heartbeats.ts, pure and deterministic, with PULSE_MS=100, UNIT_MS=400, STALL_MS=86_400_000, DEFAULT_TIMEOUT_MS=300. buildScenario(input) returns events and outcome only. Fix the outcome: `results: null` on timeout; add `collected` only if the picture must show the discarded slice.

Scenes: scene 1 (default) is the scaffold healthy run: one buffered pulse at t=0 with no reader, results 0-2 collected, the flat 1.5s timer fires while unit 3 runs, returns nil/error. Scene 2 is the scaffold stall at unit 2: last sign of life at 0.8s, fire at 1.5s (700ms after the silence, 200ms past the 1.3s bound), nil/error. Scenes 3-4 are the fixed healthy and stall runs, behind the Solution gate and default to fixed mode there.

Controls: Problem mode gets transport (play, pause, step, restart, speed), a native range scrubber, and the stall-unit choice. Solution mode adds the source switch and, optionally, the separate-goroutine ticker anti-pattern, modeled with an explicit `go pulseLoop()`.

Rendering: vertical time axis, two lanes, labels outside the SVG in normal flow. Theme through CSS classes that use the existing variables. Start paused at t=0 when prefers-reduced-motion is set; step mode stays available. Keyboard: space toggles play, arrows step, Home restarts, all on real buttons plus the range input. Add a text alternative for the SVG.

Verification: web/scripts/viz-check.ts run with node (no new dependency) asserts the 1.5s flat-deadline, 1.1s fixed-detection and 1.3s-bound landmarks, and the null-result outcomes. Trim to this scope to keep the work at M.

**Verifier note.** I agree with the tier (high) and with both product answers: put the visualisation inline in the Problem tab, not in a third tab, and build it for the web app only. I do not agree with spoiler_safe as written, and two scene outcomes are factually wrong, so `agrees` is false and the design needs the changes above.

Empirical checks: I ran HEAD's 27-heartbeats/main.go, mockworker.go and check_test.go in a temp module with go1.25.6. The scaffold fails all three tests exactly as the analyst says: 1.5s healthy timeout, 1.5s stall detection against the 1.3s bound, and 900ms for the concurrent 3-unit run. A probe test confirmed both timeout paths return nil results.

All ties_to_code references check out: main.go:82, 92-96, 103, 128, 140, 144-155; mockworker.go:16, 69-79, 97-101; check_test.go:87; solutions/27-heartbeats.md:136-143 and 186-204.

Value: the timeline does make the blind spot visible — the flat deadline is too short for the healthy 2.0s job and too late for the stall, and no flat value can satisfy both. The value is concentrated in the scaffold scenes, because the Problem tab already renders the README diagram. Build scenes 1-2 first; the fixed scenes are a bonus behind the gate.

**Risks.**
- Placement answer: use problem-inline, not a third tab. A third tab widens router.parseRoute/routePath and DocPane's tab union, and it needs a per-exercise opt-in in the generated index, or all 43 exercises show an empty tab. Inline needs no route change and sits beside the sentence that names the symptom. Reuse the same component in the Solution tab in fixed mode behind the existing reveal gate, instead of a second implementation.
- Placement answer: web only. The cloned-repo learner has no renderer, and the lint layout rule at tools/check/lint.go:154 blocks files inside an exercise folder. The README ASCII diagram and the solution doc's timing arithmetic stay the local explanation. The interactive is an addition for the site, not a replacement.
- A 24h stall on a 2s axis needs an explicit axis break and a 'not to scale' label. Without it, the stall reads as a short gap and the promptness point is lost.
- The independent-ticker control can backfire: a steady ticker looks more correct than a pulse that stops during a stall. Label it as the anti-pattern in the control and in the lane caption.
- At 320px, a horizontal axis clips. Use a vertical time axis, keep labels outside the SVG, and test light and dark through the CSS variables. Do not require hover: focus and cursor must show the same state.
- The scenario constants can drift from main.go and mockworker.go. Keep one TS constants block with a comment that names the Go source, and add a test that recomputes the 1.5s and 1.1s landmarks.
- The README diagram already carries the reset-versus-silence shape. A weak duplicate adds nothing. The visual must add the two failure cases, the startup-only pulse and the test-bound marker.

**Why this tier.** A heartbeat resets the deadline; no single flat timeout satisfies both bounds. The bar is the mechanism.

<a id="28-replicated-requests"></a>
#### 28 — Replicated Requests: Racing Redundant Calls for Lower Tail Latency
`Tier B` · **high** · goroutine lanes · family `lanes` · effort M · README diagram: yes

**Pattern.** Hedged / replicated requests: fan out one call to N redundant replicas, return the first answer, and cancel the losers through a shared done channel. The failure mode is a goroutine leak that produces a correct answer.

**Core idea.** Returning a value from FetchFastest does not stop the goroutines it started. A replica handed a nil done channel can never be told to stop, so every loser runs to its full latency after the caller is gone. Cancellation must be wired to both ways the call ends: a replica winning, and the caller's own done firing.

**What prose and tests cannot show.** The program prints the right value and exits 0, so the leak is invisible at the terminal. Three things cannot be seen from the prose: (1) a nil channel blocks forever, so the mock's `case <-done` arm at 28-replicated-requests/mockreplica.go:61 is dead code; (2) the losers' timelines extend past the caller's return, and the waste is exactly their tail latency; (3) cancellation alone is not enough — a loser that observes `done` and then runs `results <- ...` on an unbuffered channel blocks forever, so the leak changes cause instead of disappearing. The tests only see all three through `ObservedCancellation()` / `RanToCompletion()` bookkeeping, never through the output.

**Design.** A four-lane timeline on a 0–460 ms clock. The top lane is the caller running FetchFastest; below it are replica-A (150 ms), replica-B (10 ms), replica-C (300 ms). Each replica lane shows a request bar that starts at t=0 and, in the scaffold, runs to its own full latency regardless of what the caller does. The caller lane ends at t=10 ms when B sends on `results`; a vertical "returned" line is drawn there and the three replica lanes simply continue through it, shaded as "nobody is listening". A counter at the right margin reads "goroutines alive" and does not drop; a second number, "wasted replica time", climbs to 140 + 290 ms. In the fixed scene the same lanes are replayed with a `stop` channel: at t=10 ms a `close(stop)` pulse travels to every replica lane, each one's bar terminates at the same instant, and the counter goes 4 to 0 at the return line. One control empties the results buffer to 0, and the losers stop at t=10 ms but their lanes end in a standing "blocked on send" glyph while the counter refuses to fall — the same leak with a new cause.

**Scenes.**
1. **Losers run past the return** — Default, spoiler-safe. Scaffold replay: A at 150 ms, B at 10 ms, C at 300 ms, each called with r(nil). B's bar ends at 10 ms and its result reaches the caller; the caller lane ends with a vertical 'returned' rule at 10 ms. A and C keep drawing to 150 and 300 ms, behind a label 'the caller is gone'. The goroutine counter reads 4, then 1 at the return line, then 0 only at 300 ms. The wasted-time counter ends at 430 replica-ms.
2. **Caller cancels first** — Scaffold replay with the caller's done closed at 5 ms, before any reply. The caller lane ends at 5 ms with 'cancelled before any replica responded'; all three replica lanes still run to 150/300 ms because none of them is holding the caller's channel. Teaches the second cancellation trigger without showing how to wire it.
3. **One stop channel, closed on every return** — Opt-in 'show the fix' scene. Every replica is called with r(stop). At 10 ms B sends, the caller receives, and defer close(stop) fires on the return path: a single close pulse fans out and all three replica bars terminate at 10 ms. The counter goes 4 to 0 at the return line. A 'results buffer' control set to 0 replays the same scene and ends with the two losers standing in a 'blocked on results <-' state and the counter stuck at 2.

**Controls.** Play / pause (Space), step forward and back (arrow keys), restart (R). Never starts playing without a press.; Scenario switch: replica wins / caller cancels first / the fix. The fix is a separate, labelled choice, so the default view is the scaffold.; Replica C latency: 100 ms to 400 ms. The wasted-time total moves with it, which shows the cost of a leak equals the tail latency.; Replica count: 2 to 5. Adds or removes lanes and shows the buffer size must match the fan-out.; Results buffer: len(replicas) or 0 (fix scene only). This is the second-leak control.; Show sequential baseline: bars for calling A, then B, then C one after another (460 ms), beside the 10 ms race..

**Annotations.** r(nil) — a receive on a nil channel can never become ready, so `case <-done` never fires; timer.C fires — the replica returns its own value and err; results <- replicaResult{value, err}; FetchFastest returns — the call is over, the goroutines it started are not; close(stop) — every replica's `case <-done` becomes ready at once; defer close(stop) — runs on both return paths: a winner, or the caller's done; done closed by the caller — the second cancellation trigger; goroutines alive: 4 → 1 → 0; wasted replica time: the unused remainder of each loser's latency; blocked on send — an unbuffered results channel with no receiver left; ObservedCancellation() / RanToCompletion() — what the test can see and the printout cannot.

**Data model.** Renderer contract, one scripted scenario per exercise id.

entities: [{id:"caller", kind:"goroutine", label:"FetchFastest", lane:0}, {id:"rA", kind:"goroutine", label:"replica-A", latencyMs:150}, {id:"rB", ...10}, {id:"rC", ...300}, {id:"done", kind:"channel", label:"done (caller)", buffer:0, closedBy:"caller"}, {id:"stop", kind:"channel", label:"stop", buffer:0, present:fixed}, {id:"results", kind:"channel", label:"results", buffer:4}]

events: [{t, type, actor, target?, channel?, value?, note?}] with types: spawn, call(doneArg:"nil"|"stop"), block(on:"timer"|"nilDone"|"send"|"recv"), timerFire, close, send, recv, unblock, return, exit, leak(leakKind:"timer"|"send").

A lane bar is derived: from call (or spawn) to the next exit/leak for that actor; block/unblock split it into working and blocked segments.

Worked scaffold timeline: t=0 spawn rA,rB,rC; call r(nil) each; block timer. t=10 timerFire rB; send rB→results; recv caller←results; return caller; exit rB. t=150 timerFire rA; send rA(no receiver needed, buffer has room); exit rA. t=300 timerFire rC; send; exit rC. leakedMs = 140 + 290.

Fixed timeline: same until t=10, then close caller→stop; every replica gets unblock(done); each sends to results (buffered) and exits; goroutinesAlive 4→0 at t=10.

Unbuffered fixed timeline: same close at t=10; A and C wake, then block on send with no receiver; they never exit; leak(leakKind:"send").

Derived counters: goroutinesAlive(t), wastedMs(t), winner(actor|null), callerState (running|returned|cancelled).

**Code anchors.**
- 28-replicated-requests/main.go:69 — `value, err := r(nil)`, the line the scaffold scene explains
- 28-replicated-requests/main.go:70 — `results <- replicaResult{value: value, err: err}`, the send that becomes the second leak when unbuffered
- 28-replicated-requests/main.go:60 — `results := make(chan replicaResult, len(replicas))`, the buffer the fix scene ties to the fan-out size
- 28-replicated-requests/main.go:74-78 — the select's two branches, the two cancellation triggers
- 28-replicated-requests/main.go:62-71 — the fan-out loop that starts one goroutine per replica
- 28-replicated-requests/mockreplica.go:55-65 — the mock's `select` on timer.C vs done; the dead arm under the scaffold
- 28-replicated-requests/mockreplica.go:72-76 and :81 — ObservedCancellation and RanToCompletion, the only observability the tests have
- solutions/28-replicated-requests.md Approach 1 — `stop := make(chan struct{})`, `defer close(stop)`, `r(stop)`
- 28-replicated-requests/check_test.go — TestFetchFastestReturnsFastestValue (5 ms reaction window, 400 ms drain) and TestFetchFastestClosedDoneCancelsEarly (the second trigger)
- 28-replicated-requests/README.md:12-32 — the two ASCII diagrams the tab replaces with movement

**Verifier corrections — read before building.**
- The verdict overstates the need for "must". The scaffold is not silent about its bug: main.go:64-68 carries a BUG comment that names the nil done, and main.go:94-96 prints "...but replica-A and replica-C are still out there, running to completion". README.md:18-22 already states the leak in prose. Of the analyst's three "cannot be seen from the prose" facts, only the unbuffered-send trap is absent from the exercise README (it lives in solutions/28-replicated-requests.md:157). "High" is defensible because the timeline adds a clock and the wasted total; "must" is not.
- The goroutine counter arithmetic is wrong. With the caller plus three replicas: 4 at t=0; at t=10 the caller returns AND B exits, leaving A and C alive, so 2, not 1; then 1 at t=150; 0 at t=300. The proposal's "4 → 1 → 0" drops a live goroutine and skips A's exit. Derive the counter from the event list instead of asserting values.
- A third tab is premature and inconsistent. router.ts:5-7 (Route.tab), :9-13 (parseRoute) and :15-18 (routePath), DocPane.tsx:11 and :26-32, and ExerciseView.tsx:10 all need a third value; only one of 43 exercises would have a script, so the tab bar differs per exercise and frames the visualisation as a peer of Problem and Solution. A lazy, collapsible section inside the Problem tab needs none of that.
- "spoiler_safe": true is honest only for the default scene. Scene 3 plus annotations 5-9 (`close(stop)`, `defer close(stop)`, `r(stop)`, "caller's done") reproduce Approach 1 from solutions/28-replicated-requests.md:111-128 with one click in an ungated tab, bypassing the spoiler button at DocPane.tsx:57-68. Either move the fix replay into the Solution tab after the reveal, or drop it.
- The linear clock does not fit the pane. The hard limit is 320px, but the actual content box is narrower: styles.css:506 gives the doc pane minmax(260px, ...) and styles.css:574 pads the body 16px 22px, so content can be ~216px (about 288px on a 320px phone). On a linear 0-460ms axis the 10ms return marker sits 2-5% from the origin, a few pixels from the start, which is precisely the event the visual exists to show. Use a broken axis with a 0-20ms inset, or shade each loser's post-return segment as the waste and mark the return with a leader label.
- Six controls (scenario, latency, replica count, results buffer, sequential baseline, transport) plus 3-5 lanes, a legend, two counters and 11 annotations is a kitchen sink for a 216-288px pane and for one insight. Drop the latency slider (the fixed 150/10/300 demo values already show waste = tail latency), the replica-count slider (it invents latencies for D and E), and the sequential toggle (state 150+10+300 = 460ms as one caption line). Move the buffer-0 control to the Solution tab.
- The generic event-schema renderer is over-engineered for one script. Defining spawn/call/block/timerFire/close/send/recv/unblock/return/exit/leak plus derived lane segments is an interpreter to maintain and test. A self-contained component per exercise with a small internal event list is less code and easier to verify. Keep only the id-to-lazy-import registry shared.
- The visualisation cannot "replace" the ASCII diagrams. tools/check/lint.go:256-257 requires an ASCII diagram in every exercise README, and a clone-mode reader only has the README, so README.md:12-32 must stay. The proposal's ties_to_code entry calling the diagrams "the two ASCII diagrams the tab replaces" is wrong; the visual complements them, and no README edit may remove them.
- Motion and keyboard details need to be explicit. styles.css:1067-1075 handles only two transitions today, so the component must add its own prefers-reduced-motion rule and start in step mode; no autoplay; every control is a real button; captions need aria-live. Also label the lanes "scripted" and cite GOMAXPROCS=1 (web/README.md:42-44) so a viewer does not read the drawing as an observed schedule.
- Minor factual wording: mockreplica.go:61's `case <-done` is unreachable under the scaffold because done is nil, not dead code in the file; the tests exercise that arm after the fix. Also note the scaffold's results channel is already correctly buffered at main.go:60, so the buffer-0 replay is a hypothetical the learner only meets if they rewrite that line, not part of the scaffold's failure.

**Corrected design (use where it conflicts with the design above).**

PLACEMENT (answers the user's first question). Web only, and not a third tab yet. Ship one lazy React component under web/src/vis/ (new files are legal there; tools/check/lint.go:154 only restricts exercise folders). Render the scaffold-symptom timeline in the Problem tab as a native <details> summary (closed by default), placed after the README Markdown and before the pager in DocPane.tsx:53-84. This keeps the spoiler gate structural: the fix replay goes in the Solution tab, rendered only after the existing `revealed` button (DocPane.tsx:57-68). No router.ts or ExerciseView.tsx change is needed for one exercise. Promote this to a real tab only when several exercises have scripts and the registry justifies the router work. Keep README.md:12-32 untouched; the diagram is mandatory (lint.go:256-257) and serves clone mode.

MODES (second question). Web only; no clone-mode parity. The clone-mode learner already gets the two ASCII diagrams, the BUG comment at main.go:64-68, and a run of main.go that prints the leak warning at main.go:94-96. A terminal animation would need tcell/bubbletea, a second implementation of the same script, and would break the repo's bare-bones exercise style. Say on the site that the timeline is a web extra; do not claim parity.

TIMELINE. One shared clock, four lanes: caller, replica-A (150ms), replica-B (10ms), replica-C (300ms). Default scene is the scaffold: B returns at 10ms, the caller lane ends there, A and C keep drawing to 150 and 300ms. Because 10ms is a few pixels on a linear 0-460ms axis at 216-288px, do not use a plain linear scale: shade the post-return segment of A and C as waste and label the return line with a leader, or add a 0-20ms inset before a 20-300ms axis. Counters as text lines under the lanes: "goroutines alive 4 → 2 → 1 → 0" and "wasted replica-ms 140 + 290 = 430", both derived from the event list, never hard-coded. Optional second Problem scene: the caller's done closes at 5ms and all three lanes still run, showing the second cancellation trigger. No fix scene here.

SOLUTION TAB (after reveal). Replay the `defer close(stop)` fix: all three lanes stop at 10ms and the counter goes 4 → 0. Then the buffer-0 variant: A and C wake but stand in a "blocked on results <-" state and the counter sticks at 2. Only these scenes may name stop/close/defer. The scaffold scene's annotations are limited to r(nil), the timer firing, the results send, the return, and the counters.

CONTROLS. Play/Pause (Space), Step back/forward (arrow keys), Restart (R), and two scene buttons. Real buttons, no hover-only affordances, no autoplay. prefers-reduced-motion starts in step mode and disables transitions; add the rule beside styles.css:1067-1075. aria-live="polite" caption describes the current step. Use the CSS-variable tokens from styles.css:1-87 for light and dark; SVG or divs, no new npm dependency. Lazy-load through a small registry in web/src/vis/index.ts (id → dynamic import), so the chunk loads when the details opens or the solution is revealed; the generator stays untouched because web/tools/gen/main.go:484-486 only reads .go, .md and go.mod.

EFFORT. With this scope, S-M, not the proposal's M.

**Verifier note.** Verification method: I read every exercise file through `git show HEAD:<path>` and the web files from HEAD as well. The proposal's line citations for main.go (60, 62-71, 69, 70, 74-78), mockreplica.go (55-65, 61, 72-76, 81), README.md (12-32), check_test.go (5ms window, 400ms drain) and the solution doc all check out. The scaffold's failure mode is real: r(nil) at main.go:69 makes the mock's `case <-done` unreachable, A and C run 140ms and 290ms past the caller's 10ms return, and the results channel at main.go:60 (buffer len(replicas)) lets their sends succeed and their goroutines exit, exactly as described. The "cancellation alone is not enough" trap is real: an unbuffered results channel makes A and C block forever on `results <-`, confirmed by the solution doc's synctest panic note at solutions/28-replicated-requests.md:157. The 430 replica-ms total is right. The goroutine counter is not (see issues).

The visual form (goroutine lanes on a clock) is the right one, and it is not decoration: the shared clock plus the wasted-ms total are genuinely new, and the unbuffered-send replay is a real second lesson. But the exercise is not blind, so "must" overstates. The design is feasible with no new dependency; the changes are placement (Problem/Solution sections instead of a new tab, and no router work), scope (drop three of six controls), arithmetic, and the axis scale. I did not run the app or the smoke test; feasibility rests on the code read.

**Risks.**
- Placement and modes: a third tab is right for the web app, and only the web app. The clone-mode learner gets README.md:12-32, which already shows the scaffold/goal shape; a terminal animation would need a new Go dependency (tcell/bubbletea) and would duplicate a scripted timeline for no extra lesson. Say 'web only' in the tab and do not attempt parity.
- Tab wiring is not free: web/src/router.ts:5-7 hard-codes two tabs (`tab: "problem" | "solution"`), routePath at :10-12 and DocPane.tsx:26-32 each need a third value, and the tab must appear only for ids that have a script (a registry in web/src/vis/). This is real but small, and it is the same code path for every later exercise.
- Do not let the tab become a second solution doc. The buffer-size detail is the solution doc's hardest payoff; if the default scene renders the results channel at all, show it as an unnamed collector, and keep the buffer-0 replay behind the labelled 'the fix' scene.
- A scripted clock implies scheduling order the browser cannot guarantee. Label it 'scripted'; never animate sub-millisecond interleaving, and note GOMAXPROCS=1 (web/README.md) so the learner does not infer parallel execution.
- The leak self-heals here because the mock's timers eventually fire. An unchecked viewer may conclude leaking is harmless. The wasted-ms counter and a 'in real code this work never finishes' caption are load-bearing, not decoration.
- At 320 px four lanes plus labels do not fit horizontally. Use single-letter lane tags with a legend, put counters as text lines under the lanes, and forbid horizontal page scroll (the site sets a 16 px gutter below 900 px).
- Reduced motion and keyboard: no autoplay, no hover-only affordance, and prefers-reduced-motion must land on step mode with the same information density (styles.css:1067 only handles two transitions today).
- New files go under web/src/vis/, never inside 28-replicated-requests/ — tools/check/lint.go:154 rejects anything but README.md and .go there, and the generator only reads HEAD anyway.
- The visualisation must not be generated from the exercise JSON: web/tools/gen/main.go reads only .go, .md and go.mod from git archive HEAD, so scenario data belongs in a small TS module loaded lazily with the tab.

**Why this tier.** Returning does not cancel: the caller lane ends while replica lanes keep running; wasted replica-ms are counted.

<a id="29-healing-goroutines"></a>
#### 29 — Healing Unhealthy Goroutines: A Steward That Restarts a Wedged Ward
`Tier B` · **high** · goroutine lanes · family `lanes` · effort M · README diagram: **no — draw it first**

**Pattern.** Supervision tree / heartbeat watchdog. A monitor goroutine owns one live "generation" of a child goroutine, treats a heartbeat pulse as proof of liveness, and on a stall closes the generation's own done channel and starts a fresh generation with a fresh done, without ever waiting for the old one. The steward has the same StartGoroutineFn shape as the ward, so stewards compose.

**Core idea.** A heartbeat proves liveness, not exit. A wedged goroutine never returns and ignores `done`, so a supervisor must judge it by elapsed time since the last pulse, then abandon it: close a steward-owned per-generation `wardDone` (close never blocks), drop the reference, and start a new generation with a new channel. The supervisor must never wait on a goroutine that may never come back.

**What prose and tests cannot show.** The failure is an absence, not an event. After the last pulse, the ward's heartbeat channel simply stays open and silent; nothing panics, nothing closes, and the steward's own returned heartbeat goes silent forever. Three things are invisible in prose and only indirectly in tests: (a) the deadline must reset on every forwarded pulse (a fixed ticker also keeps pulses flowing, but it churns a healthy ward - check_test.go:156 asserts Generations()==1 to catch this); (b) the old generation is abandoned and leaked on purpose while the new one runs, so two lanes coexist for a moment; (c) `close(wardDone)` is best effort and cannot be awaited. The tests only count generations and compare channel identities (check_test.go:94), so the interleaving of pulse, deadline, close and new generation never appears.

**Design.** One time axis, left to right, with three stacked lanes: caller (the goroutine reading the steward's heartbeat), steward (the select loop), and ward generation 1. Every `pulseInterval` a small pulse token travels from the ward lane through the steward lane to the caller lane, and each token that the steward forwards refills a horizontal deadline bar drawn under the steward to full width (`timeout`). In the default scaffold scene there is no deadline bar and never a second lane: the ward emits five tokens, its lane turns grey and stops, a label reads "silent - channel never closed, done ignored", the steward line goes flat, and the caller's "no pulse for ..." counter climbs without end while a `ward generations: 1` readout stays frozen. In the healed run the bar drains to zero after `timeout`, a small close marker is stamped on generation 1's done token, generation 1 stays grey and labelled "abandoned, not awaited", and a new lane, generation 2, appears below with a visibly different done token; pulses resume and the caller's counter continues without a gap in the total. A side readout lists `Generations` and the `Dones()` tokens as distinct small shapes so "same channel reused" versus "fresh channel per generation" is something the eye can check.

**Scenes.**
1. **Silent wedge (scaffold, default)** — The pass-through. Ward lane pulses five times, then greys out with 'silent: channel open, no sends, done never read'. The steward has no deadline bar and no timeout case, so its line goes flat and the caller's receive blocks forever. The 'no pulse for ...' counter climbs to the end of the visible timeline; 'ward generations: 1' never changes. Annotations: 'send stops', 'recv blocks', 'no case can fire'.
2. **The deadline resets on every pulse** — Same lanes with the deadline bar on. A healthy ward refills the bar before it empties, so it never fires and Generations stays 1 - the invariant check_test.go:156 asserts. Then the ward wedges and the bar drains to zero while the caller waits. A side note compares this with a fixed ticker, which would fire on a healthy ward and churn it.
3. **The heal** — At zero the steward stamps a close on generation 1's done token, leaves that lane grey and running/abandoned, mints a visually different token for generation 2, starts the lane, and re-arms the bar. Pulses resume; the caller's total keeps climbing. Generations goes 1 -> 2 -> 3 and the Dones readout lists three distinct tokens. Pressing 'close steward done' stamps the current generation and stops all lanes, with no further generation afterward.
4. **Broken variants** — Three switches, each with one distinct symptom. 'Fixed ticker': a healthy ward still churns new generations while every pulse arrives. 'Reuse the caller's done': every generation lane carries the same token, and one more generation starts after done is closed. 'Slow reader': the deadline bar freezes while the blocking forward waits, so a wedge is detected only when the reader catches up.

**Controls.** Play, pause, step, restart (no autoplay; step is the reduced-motion path); Timeout slider from 0.5x to 4x pulseInterval - too short thrashes a healthy ward, too long lengthens the silence; Wedge the ward now / keep it healthy (pulsesBeforeWedge 2 vs 1000) - shows that a healthy ward is never restarted; Close steward done - shows that shutdown closes only the current generation and stops the loop; Toggle 'restart on a fixed ticker' - the healthy-ward churn bug; Toggle 'reuse caller's done as wardDone' - identical tokens in the Dones readout; Toggle 'slow reader' - the blocking-forward trade-off freezes the deadline.

**Annotations.** pulse forwarded - deadline reset to timeout; select loop: one serial state machine, no mutex; deadline fires - no pulse for at least timeout; close(wardDone) returns immediately - best effort; wedged: ignores done, never exits (mock: goroutine returned; real: hangs); abandoned generation - leaked on purpose, not awaited; fresh steward-owned wardDone - new token; caller recv blocks on steward heartbeat; done closed - current wardDone closed, loop returns, heartbeat closes; generation count and Dones tokens.

**Data model.** Entities: Caller goroutine; Steward monitor goroutine (owns wardDone_i, wardHeartbeat_i, timeoutC - all local, no shared state); WardGeneration { id, wardDone token, heartbeat, pulsesBeforeWedge, state: pulsing | silent | wedged }; channels { doneIn, wardDone_i, wardHeartbeat_i, stewardHeartbeat }; Deadline { genId, armedAt, firesAt = armedAt + timeout }. Events on a pseudo-time axis in units of pulseInterval: spawnGen(genId, token), sendPulse(t), recvPulse(t), forwardPulse(t) with optional block/unblock on stewardHeartbeat, resetDeadline(t), deadlineFire(t), closeWardDone(genId, t), abandonGen(genId), wedge(t), doneClose(t), exit(t), and derived readouts genCount and dones[]. Scenes are declarative event scripts, not computed from Date.now(), so any time t can be recomputed by replaying events up to t: currentGen, per-gen state, deadline remaining, caller counter, generation/token list. Pulse k of a generation fires at k*pulseInterval; the wedge is the tick after pulsesBeforeWedge; the deadline fires at lastPulse + timeout; the restart happens at that same instant.

**Code anchors.**
- 29-healing-goroutines/main.go:60 - type StartGoroutineFn - the shape that lets the caller lane itself be another steward
- 29-healing-goroutines/main.go:67-76 - NewSteward returns ward(done, pulseInterval) unchanged (main.go:75): the pass-through with no deadline and exactly one generation
- 29-healing-goroutines/mockward.go:73-115 - MockWard.Start; mockward.go:99 the wedge is a bare return that leaves heartbeat open and never reads done again - the grey lane that never recovers
- 29-healing-goroutines/mockward.go:44 and :56 - Generations and Dones, the two readouts the visualisation shows; Dones is what makes token identity visible
- solutions/29-healing-goroutines.md:86-88 - startGeneration mints wardDone := make(chan struct{}) - the fresh per-lane token
- solutions/29-healing-goroutines.md:99-100, 144, 155 - time.After(timeout) re-armed after every forwarded pulse - the refilling deadline bar
- solutions/29-healing-goroutines.md:146-155 - case <-timeoutC: close(wardDone), start a new generation, re-arm - the heal moment
- solutions/29-healing-goroutines.md:116 and 141 - case <-done: close(wardDone); return - the shutdown control
- solutions/29-healing-goroutines.md:134 - wardHeartbeat = nil disables a closed channel instead of hot-spinning
- 29-healing-goroutines/check_test.go:20, :94, :156 - the three tests: restart count, fresh done identity, and no restart on a healthy ward

**Verifier corrections — read before building.**
- Placement is not implementable as written: DocPane.tsx:53-58 renders the README as one opaque Markdown string (Markdown.tsx:59 uses dangerouslySetInnerHTML), so a component "under the paragraph that introduces the wedge" needs a markdown directive or a parser change. The later claim that above/below needs no parser is the feasible version, but it contradicts placement_hint "problem-inline".
- The Problem-tab default scene duplicates what the learner can already see: CodePane.tsx:449-450 has a "Run main" button (runMain at :192-211) that runs main.go; main.go:92-99 prints 4 pulses then "no pulse this round" for the rest and ends with "ward generations started: 1". The unique content is the healed timeline, which is solution material.
- The scaffold has no steward goroutine: main.go:75 is `return ward(done, pulseInterval)`. Drawing a "steward lane" that "goes flat" or says "no case can fire" invents a select loop that does not exist yet; the default scene should show caller + ward only (or a transparent pass-through).
- Wedge timing is off by one tick: mockward.go:91-106 sends pulse N and returns in the same tick, so silence starts at pulsesBeforeWedge*P, not the tick after, as data_model says.
- Deadline arming is underspecified: solutions/29-healing-goroutines.md:103-104 arms timeoutC at generation start, then re-arms after every forwarded pulse (:144) and after restart (:155). A bar that only "refills on pulse" misses the initial arm and the 0.5x-timeout thrash case.
- The reuse-done variant is described wrong: with the spec's own `case <-done` (solutions:108-117), closing done stops the steward; the "one more generation after done" symptom needs the variant that reuses done and has no explicit done case, relying on the pass-through (the variant check_test.go:62-77 describes).
- The caller counter does not climb without end: main.go:92-99 loops exactly 10 rounds, then closes done. The viz may extrapolate but must label it conceptual; and the default pulse count is 4 (main.go:83), not the 5 used in the scenes (check_test.go:25).
- The width budget is 288px, not 320px: at a 320px viewport .doc-body uses 16px side padding (styles.css:1037-1038). Seven independent controls plus lanes, a deadline bar and a Dones readout will not fit. A third tab would overflow .doc-tabs (styles.css:540-547, no flex-wrap) past the difficulty and passed badges.
- The lazy-load mechanism is unspecified: the app has no React.lazy/Suspense usage today. Name a web/src viz registry with lazy(() => import(...)) and mount it only in the revealed Solution branch; no new npm dependency is needed.
- A component type error would not be caught by the repo's gates: make check (Makefile:20-21) does not build web/, and CI's web job runs prepare-data and smoke, not npm run build/tsc (.github/workflows/check.yml:38-41). Run `cd web && npm run build` locally, and consider closing the CI gap.
- Accessibility and motion are incomplete: the design lists keyboard controls but no text equivalent; add an aria-live frame narration and aria-hidden on the SVG. The existing reduced-motion block (styles.css:1067) only disables transitions, so the viz must default to paused and, under reduce, disable autoplay (or make Play advance one frame).
- spoiler_safe is only honest if the healed and parameter scenes stay behind the Solution reveal. A one-click "heal it" in the Problem tab is weaker than the existing gate (DocPane.tsx:57-68); moving the whole explainer into the Solution branch makes it trivially safe.
- ties_to_code has minor line errors: mockward.go:73-115 is 73-112; the wedge return is at :105, not :99; the Generations()==1 assertion is at check_test.go:188, not :156. The design's own "Dones tokens" are an analogy (Go channels have no visible identity), so caption that.
- The clone/GitHub mode needs the plain-fence ASCII diagram in 29-healing-goroutines/README.md (hasDiagram accepts only ``` or ```text fences with diagram chars, lint.go:407-428); that also clears the exception at lint.go:49. The interactive component cannot work in the clone.

**Corrected design (use where it conflicts with the design above).**

Keep the goroutine-lane form (the lane/deadline/token picture is the right one), but change the host and correct the scenarios.

HOST AND MODES
- No third tab. DocPane's tab row (DocPane.tsx:26-40) already carries Problem, Solution, the difficulty badge and the passed badge; at a 320px viewport the doc body is 288px wide (styles.css:1037-1038) and .doc-tabs does not wrap (styles.css:540-547). A third tab overflows.
- Do not put the interactive explainer in the Problem tab. \"Run main\" (CodePane.tsx:449-450) already runs main.go and prints the flatline (main.go:92-99), so the symptom is observable; the new content (deadline refill, abandoned generation, fresh wardDone) is solution material.
- Mount a collapsed <HealingViz> in the Solution tab's revealed branch (DocPane.tsx:57-58), above the worked-solution markdown. This needs no router change and no markdown-parser change. If a Problem-tab presence is required, make it a static, symptom-only strip with no deadline bar, no second lane and no heal control, and accept that it repeats \"Run main\".
- Lazy-load through a web/src/viz registry: id -> lazy(() => import(\"./29-healing-goroutines.tsx\")), rendered inside Suspense only when the Solution tab is revealed and the block is opened. SVG + CSS variables; no new npm package.
- Web-only for the interactive part. The clone/GitHub artifact is a plain-fence ASCII diagram in 29-healing-goroutines/README.md (today: pass-through flatline; goal: steward restarts with a fresh wardDone). That also clears the readme-diagram 29-healing-goroutines exception at tools/check/lint.go:49.

SCENARIO CORRECTIONS
- Default scene: caller + ward only. main.go:75 is a direct pass-through; there is no steward goroutine and no select loop. Introduce the steward lane only in the healed scene; the \"one serial select loop, no mutex\" annotation belongs there (solutions:106-157).
- Wedge: mockward.go:91-106 sends the last pulse and returns in the same tick. Silence starts at pulsesBeforeWedge*P, not the next tick. Use 4 pulses for the scaffold scene (main.go:83) or 5 for a scene labelled \"test constants\" (check_test.go:25); do not mix.
- Deadline: arm it at generation start (solutions:103-104), reset it after every forwarded pulse (:144), re-arm it after restart (:155). This makes the 0.5x-timeout thrash demo correct.
- Heal: close gen 1's wardDone, keep that lane grey with \"delivered, never read\" (mockward.go:99-106 has already returned), then start gen 2 with a fresh token. Show the real gap (up to timeout + P) before the next pulse; do not render the new lane before the close marker.
- Reuse-done variant: label it \"reuse done and rely on it for shutdown\" (no explicit done case). Only then does closing done fail to stop the monitor loop and start another generation (check_test.go:62-77); with the spec's done case (solutions:108-117), the symptom is just identical tokens in Dones.
- Slow-reader variant: keep it. It is the blocking-forward trade-off the solution doc names; show the deadline bar frozen while the forward blocks.
- Caller counter: main.go:92-99 runs exactly 10 rounds. Either animate 10 rounds or label the timeline \"conceptual, beyond main's 10 rounds\".
- Caption the Dones shapes as a stand-in for channel identity, not a Go-visible property.

LAYOUT, ACCESSIBILITY, MOTION
- Budget 288px. Use one scene selector (Silent wedge / Healthy deadline / Heal / Broken variant) plus Play, Pause, Step, Restart and one optional timeout slider. Do not expose seven independent toggles.
- Native buttons and <input type=\"range\">; an aria-live=\"polite\" sentence narrates each frame; the SVG is aria-hidden. Nothing hover-only.
- Default to paused. Under prefers-reduced-motion: reduce, disable autoplay and make Play advance one frame per click (or hide Play and keep Step); add the rule to styles.css:1067.
- Use var(--fg), var(--fg-muted), var(--border), var(--bg-sunken), var(--accent), var(--pass), var(--fail); grey the abandoned lane with var(--fg-muted) at reduced opacity, not a fixed colour.
- State is an integer tick over a precomputed, sorted event array; frame(t) is pure. No Date.now() deltas.

MAINTENANCE
- The component is hand-maintained; add a comment with source anchors (main.go:75, mockward.go:73-112, solutions:86-155) and note that an exercise change requires updating it. No lint rule catches drift.
- Run `cd web && npm run build` before committing, because make check and CI do not type-check the app.

**Verifier note.** The verdict \"high\" stands for a Solution-tab explainer, not a Problem-tab one. The lane/deadline/token form is the right way to show the two things prose cannot: the old generation abandoned while the new one runs, and the deadline reset that keeps a healthy ward at generation 1. The README states the four requirements (29-healing-goroutines/README.md:34-48) but not that timeline; the tests only count generations and compare channel identities; the solution doc explains it in prose, which is why a visual companion is worth building for a hard exercise. But the analyst's \"problem-inline\" placement is the wrong host: the browser already has \"Run main\", and main.go prints the flatline. If the owner will not gate the explainer behind the solution reveal, downgrade to \"nice\", because the Problem-tab version mostly restates the README and the run output.

Answer to the originating question: incorporate the visualisation into the existing Solution tab, after the spoiler reveal, not a third tab and not the Problem tab. The interactive explainer is web-only; the clone/GitHub mode gets the static ASCII diagram in the exercise README, which the readme-diagram lint rule already requires and which clears the 29 exception. Feasible with changes: no new npm dependency, SVG + CSS variables + React state; the work is in scenario accuracy, the 288px layout, the lazy registry, and the accessibility/motion path. Effort \"M\" is optimistic if all four scenes and the broken variants are built; budget L.

**Risks.**
- Web only. The site reads README.md and solution docs from git HEAD as opaque markdown, and the clone has no renderer, so an inline component exists only in the browser. To keep the two modes in agreement, add a static ASCII diagram to 29-healing-goroutines/README.md as well - that also clears the known exception `readme-diagram 29-healing-goroutines` at tools/check/lint.go:49, and the lint layout rule forbids putting any visualisation file in the exercise folder.
- Spoiler margin is thin: the README already lists the four required behaviours in bullets, so the visualisation must add the timeline rather than restate them. Keep the healed scene behind a 'heal it' control and use the scaffold flatline as the default frame.
- The default scene is the pass-through, but the visualisation must not draw a fixed select loop, a timeout case, or a second lane before the learner asks for the heal.
- MockWard's wedge is a bare return (mockward.go:99): the goroutine exists, the channel stays open and silent. A real ward would hang. Do not animate a channel close or a clean exit as the wedge - the whole point is that nothing observable happens. Label the difference.
- The solution forwards pulses with a blocking send, so a stalled consumer pauses the deadline. A visualisation that always shows a fast reader hides a real bug class; either expose the slow-reader variant or do not imply detection is instant.
- At the restart instant the old generation and the new one can appear simultaneous. The invariant is close old first, never await it; if the renderer shows the new lane before the close marker, it teaches a race the solution deliberately avoids.
- 320px width: lane labels, tokens, a deadline bar and a Dones readout are tight. Put lane labels above the lane, keep labels to a few words, and never require horizontal scrolling or hover.
- The scenes must be declarative data replayable by step, not timers driven by wall-clock deltas; otherwise step, reduced motion and screenshots diverge from the deterministic contract.
- No npm dependency is needed: SVG or absolutely positioned CSS chips plus React state suffice. Adding an animation library would be hard to justify against the site's four-package baseline.

**Why this tier.** A wedged ward and a steward that restarts it; the old generation keeps pulsing below the new one.


---

## 6. If you ship the third tab

This is the complete plan for the promotion. It assumes the player and the registry from §4 exist.

### 6.1 Route

`web/src/router.ts:6` types the tab as `"problem" | "solution"`. Widen it to `"problem" | "solution" | "visualisation"`.

`parseRoute` (`web/src/router.ts:9-13`) maps any unknown segment to `problem`. Add one branch:

```ts
if (segment === "visualisation" && hasVisualisation(id)) {
  return { id, tab: "visualisation" };
}
```

`routePath` (`web/src/router.ts:15-18`) returns `/<id>/visualisation` for the new tab.

A deep link to an exercise without a scene must not dead-end. In `useRoute`, rewrite it once:

```ts
if (route.id && route.tab !== "visualisation" && /\/visualisation\/?$/.test(location.pathname)) {
  history.replaceState(null, "", `/${route.id}`);
}
```

Use `replaceState`, not `pushState`: Back must not return to the dead URL.

### 6.2 Tab markup

`DocPane.tsx:26-32` renders two anchors. Add a conditional third anchor, only when `hasVisualisation(id)` is true. Keep `Solution` last.

Order: `Problem | Visualisation | Solution`.

The tab label is `Visualisation`. At the 260 px pane floor the row cannot hold three labels plus two badges. Apply this CSS to `web/src/styles.css:540-558`:

```css
.doc-tabs {
  flex-wrap: wrap;
  column-gap: 4px;
  row-gap: 2px;
  padding: 0 12px 2px;
}
.doc-tabs a { white-space: nowrap; }
@media (max-width: 420px) {
  .doc-tabs { padding: 0 8px 2px; }
  .doc-tabs a { padding-left: 6px; padding-right: 6px; }
}
```

The labels stay on line 1. The difficulty or `passed` badge wraps to line 2. Do not use `overflow-x: auto`: a hidden tab is undiscoverable.

### 6.3 The spoiler gate

`revealed` is local state in `DocPane.tsx:17`. The visualisation tab needs the same gate. Lift it to `ExerciseView.tsx:15-19`, which `App.tsx:84` keys by exercise id. Pass `revealed` and `onReveal` to `DocPane`. Delete the local `useState`.

This gives one gate for the Solution tab and the fix scenes. A symptom scene can render before the reveal. A fix scene cannot.

Do not add a second “Show the fix” button inside the visualisation tab.

### 6.4 ARIA

The current tab markup claims `role="tab"` with no panel and no roving `tabIndex` (`DocPane.tsx:26-32`). Fix it while you are there:

- `.doc-body` becomes `role="tabpanel"`, with `id` and `aria-labelledby` (`DocPane.tsx:42`).
- The active tab has `tabIndex={0}`; the others have `tabIndex={-1}`.
- `ArrowLeft` and `ArrowRight` move focus among the tabs. Do not auto-activate.
- Do not bind global Space or arrows. Monaco owns arrows. `.doc-body` owns Space (scroll).

### 6.5 Loading

`VisualisationPane` lazy-loads the chunk with `React.lazy` and `Suspense`. Keep a module-level cache so a return to the tab does not re-fetch. Wrap it in an error boundary: a failed chunk must show a message and a link to `/<id>`, not a blank pane.

### 6.6 Scroll reset

`.doc-body` keeps its `scrollTop` when the tab changes. Set `scrollTop = 0` in an effect keyed by `[activeTab, id]`. Do not use smooth scrolling.

### 6.7 Checks for the promotion

- `npx tsc --noEmit` passes.
- `/<pilot>/visualisation` renders the tab; `/<other>/visualisation` rewrites to `/<other>`.
- Three tabs plus both badges wrap at 260 px, 320 px, and 420 px.
- The reveal state survives a tab switch and resets on an exercise change.
- `npm run build` emits one chunk per spec.

---

## 7. Build order

### Phase 0 — the player (no exercise)

Build `spec.ts`, `fold.ts`, `VizPlayer.tsx`, and the two renderers the pilot needs: `LaneView` and `GaugeView`. Build `viz-check.ts`. Add the type-check and the check to CI.

Do not build a third tab in this phase. Mount the player in the two existing tabs.

Acceptance: a hard-coded three-step scene plays, pauses, steps, restarts, and reads correctly at 260 px in light and dark with reduced motion on.

### Phase 1 — the pilot (3 scenes)

| Order | Exercise | Why |
| --- | --- | --- |
| 1 | 04-graceful-sigint | The only exercise the browser cannot run. The site gives no feedback today. |
| 2 | 31-serve-timeout-race | The smallest real lane timeline. The verifier gave exact events. It proves the fold end to end. |
| 3 | 18-bounded-pipeline-backpressure | The only proposal the verifier accepted. It proves the gauge and the gap metric. |

Ship these three inline. Measure whether learners open the panel. If they do not, stop.

### Phase 2 — the rest of the build tier

08 (after the solution-doc fix), 13, 06, 22, 21, 27, 28, 29. Keep 19 as a special case: a caption or a `-race` scene, not a normal bug animation. Decide it in §9.

Add `GraphView`, `LatchView`, and the ring plugin for 21 as the specs need them. Reuse the lane and gauge renderers wherever possible.

### Phase 3 — promote the tab

Do this only after Phase 2 and only if the panels are used. Apply §6. Keep the inline panels or move them; do not keep both.

### Phase 4 — Tier C

Build a Tier C scene only when a Tier A or B scene already uses its renderer. The renderer is the expensive part. A new spec is cheap.

### Two-mode sync

The README diagram is the clone and GitHub artifact. The spec is the web artifact. They must change in the same commit.

- The site reads Go code from `git HEAD` and Markdown docs from the working tree (`web/tools/gen/main.go`). A README edit appears locally without a commit, and the dev server regenerates on save. The deployed site and the clone still read HEAD, so commit the doc before you push.
- The pre-commit gate refuses a commit that leaves an exercise README with unstaged changes, so a diagram cannot be left behind.
- `npm run check-visuals` refuses a spec whose `HEAD:<id>/README.md` has no plain-fence ASCII diagram.
- `npm run check-visuals` checks each spec's `provenance.anchors` against HEAD, so a scaffold edit fails the spec instead of silently making it lie.

---

## 8. Acceptance criteria

- [ ] Every scene has a one-sentence caption and a text transcript.
- [ ] Every scene says “scripted, one possible schedule, not a trace of your code”.
- [ ] Every fix scene renders only after the existing reveal.
- [ ] Every constant cites a source in `provenance.constants`.
- [ ] `viz-check` passes, and it fails when a scaffold anchor is changed.
- [ ] The figure works at 216 px of content, at 320 px viewport, in light and dark.
- [ ] Keyboard: Play, Pause, Step, Restart, and the scene selector work without a mouse.
- [ ] `prefers-reduced-motion` starts paused and disables transitions.
- [ ] No new npm dependency.
- [ ] Adding one spec grows the main bundle by at most 1 KB.
- [ ] The 12 READMEs without a diagram get one. The lint exceptions are deleted.
- [ ] `make lint`, `make check`, `npm run build`, and `npm run smoke` pass.

---

## 9. Open questions for the owner

1. **Tab label.** `Visualisation` is the repo spelling. It is also the widest label. `Visualise` is shorter. Pick one.
2. **After the tab ships, do the inline panels stay?** Two homes for one scene is a maintenance cost.
3. **Do you want usage tracking?** The skeptic asks for one measurement before the feature widens. Without it, a tab that nobody opens is pure cost.
4. **Is 19-actor-model a visualisation or a caption?** The browser passes the scaffold’s race test. The honest lesson is “run `-race` locally”. A caption may be enough.
5. **Do you want the scene scripts in `web/src/viz/specs/` or beside the solutions?** The lint layout rule forbids exercise-folder files. `web/src` is the only safe home.

---

## Appendix A — The 12 READMEs without the required ASCII diagram

`tools/check/lint.go:39-50` lists them as backlog exceptions:

06, 08, 09, 12, 13, 14, 16, 17, 20, 26, 29, 30.

Draw each today-versus-goal diagram before or alongside its visualisation. The diagram is the clone-mode artifact. The player is the web enhancement.

## Appendix B — Method

- One deep read per exercise, from `git HEAD`. The working tree holds the owner’s uncommitted solved `main.go` files, so no agent read it.
- One adversarial verifier per proposal. It re-read the README, `main.go`, `check_test.go`, mocks, and the solution doc, then tried to refute the design.
- Six cohesion passes: architecture, tab plumbing, reuse families, pedagogy, a product skeptic, and a completeness check.
- 92 agents, no empty results, 43 of 43 exercises covered.
- This document and the catalogue carry every design decision and every correction the verifier made.

## Appendix C — Files that matter

| File | Why |
| --- | --- |
| `web/src/components/DocPane.tsx` | The two tabs and the spoiler gate. |
| `web/src/router.ts` | `/id` and `/id/solution`. |
| `web/src/components/ExerciseView.tsx` | Owns the tab prop; where `revealed` moves. |
| `web/src/data.ts` | Per-exercise payload; lazy JSON fetch. |
| `web/tools/gen/main.go` | Builds the site from `.go` files at `git HEAD` and `.md` docs from the working tree. |
| `web/src/styles.css` | Tokens, `.doc-tabs` at 540, `.doc-body` at 572, reduced motion at 1067. |
| `tools/check/lint.go` | `layout` at 154, `readme-diagram` at 256. |
| `web/README.md` | Runner limits: `GOMAXPROCS=1`, no `-race`, no `os/exec`. |
