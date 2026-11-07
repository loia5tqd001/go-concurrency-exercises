# Visualisation reference

Everything a spec author needs. The types live in
`web/src/viz/engine/model.ts`; the helpers in `web/src/viz/engine/ops.ts`.

## The spec

```ts
export default defineViz({
  schema: 3,
  exercise: "06-fan-out-fan-in",            // the folder name; equals the file name
  diagrams: { today: "fnv1a:…", goal: "fnv1a:…" },   // written by npm run viz -- pin
  constants: K,                             // every number, with its source line
  anchors: [{ file, text }],                // optional: more text that must stay in a file
  spoilerOk: { word: "why the README implies it" },  // optional, rare
  scenes: [ /* SceneDef */ ],
});
```

A scene:

| Field | Meaning |
| --- | --- |
| `id`, `chip` | A short id, and the chip text (at most 8 characters: Today, Goal, Leak, Fixed). |
| `tier` | `today`, `goal`, or `inside` (see SKILL.md step 2). |
| `summary` | One sentence for screen readers (at most 160 characters). |
| `knobs` | Optional segmented controls: `{ key, label, options, value }`. The model reads `P[key]`. |
| `model` | A `Model`, or `(P) => Model` when the scene has knobs. |

A model:

| Field | Meaning |
| --- | --- |
| `nodes` | The graph. Keys are ids that programs and tags use. |
| `insight` | One or two sentences under the graph (at most 320 characters). Backticks render as code. |
| `stops` | Optional: `{ when: Match, say }`. The player pauses at the first event that matches, after the previous stop, and shows `say` (at most 140 characters). |
| `tests` | `{ id: { name, short, judge? } }`. `name` is the full Go test name; `short` at most 16 characters. |
| `code` | Optional excerpt: `{ file, text }`. `file` is a committed file of the exercise (`main.go`) or `"solution"`. Lines start with `@nodeId ` to say which goroutine owns them. `…` marks a cut. Every other line is verbatim. |
| `clock` | Optional: `{ unit: "ms", budget?: { at, label } }`. Show it when time is part of the lesson. |
| `until` | Optional: stop the run at this time, as a test timeout would. |
| `routes` | Optional: `{ "from>to": "below" | "above" }` to bend an edge around the graph. The layout already bends an edge that would cross a node. |
| `expect` | `{ outcome, tests?, t? }`. `check-visuals` runs the scene under 12 schedules; every one must end this way. |

## Nodes

`pos: [column, row]`. Data flows left to right; columns and rows count from
0; fractions such as `0.5` are allowed. Two nodes may not share a position.
On a narrow screen the grid turns, so data flows top to bottom.

| Helper | Fields | Draws |
| --- | --- | --- |
| `goroutine` | `label`, `pos`, `program`, `main?`, `spawned?`, `count?`, `base?`, `tone?` | A box: the name, and what it does now ("ProcessImage", `out <-`, "returned"). A progress bar while it works. The values it holds sit on its corner. |
| `goroutine` with `count: n` | as above | One box with a cell per member. Members are `worker[3]`; `worker[*]` is all of them. Text names a member `worker-3` (`base: 1` counts from 1 when the README does). |
| `channel` | `label`, `pos`, `cap` | A box with `cap` slots (one dashed slot when `cap: 0`). Values sit in receive order: the leftmost leaves next. "closed" when closed. |
| `waitgroup` | `label`, `pos` | A dashed pill with the counter. |
| `mutex` | `label`, `pos` | A pill with a key. The key flies to the goroutine that holds the lock. |
| `slice` | `label`, `pos`, `size` | A strip of cells, filled by `put` and `append`. |
| `timer` | `label`, `pos`, `after` | A pill with a countdown bar. A tick flies out when it fires. |
| `context` | `label`, `pos`, `deadline?` | A pill: time left, "deadline passed", or "cancelled". |
| `fact` | `label`, `pos`, `value`, `limit?`, `unit?`, `states?` | A number with a bar to its limit (red past it), or state pills. Use it for what a test measures. |

Labels are at most 14 characters and unique within a scene. In a Problem scene a label must be a word
the README or the committed code uses (a member suffix `-3` is fine).

`main: true` marks the caller, exactly one per scene. When main returns
while another goroutine is blocked, that goroutine has leaked. When main is
blocked and nothing can wake anything, the program is deadlocked.

`tone: 0 | 1 | 2` colours the values a goroutine creates. Give producers
different tones only when the lesson is how their values mix.

## Operations

A program is `function* (self) { … }`. `self` has `i` (the member index),
`P` (knob values), and `vars` (plain numbers every goroutine of one run
shares, for what a test keeps on the side, such as `consumedSoFar`).

Every operation takes a last optional argument `{ at: "out <- v" }`: a
unique piece of the code line it models. Without it, the code panel looks
for the usual Go text (`out <-` for a send on `out`, `wg.Wait()` for a wait
on `wg`) in the lines the goroutine owns.

| Helper | Go | What the scheduler does |
| --- | --- | --- |
| `work(ms, label?)` | A call that computes or sleeps as work | Runs for `ms`, with a progress bar and `label` (at most 16 characters). `Infinity` never returns. |
| `sleep(ms)` | `time.Sleep(d)` | Blocks for `ms`. |
| `send(ch, v)` | `ch <- v` | Hands `v` to a waiting receiver; else puts it in a free slot; else blocks holding it. Panics on a closed channel. Pass a received token (`r.tok`) to forward the same value. |
| `recv(ch)` → `{ ok, v, tok }` | `v, ok := <-ch` | Takes the oldest slot and pulls a blocked sender's value into the freed slot; else takes from a blocked sender; else `ok: false` if closed; else blocks. Also works on a timer (its tick) and a context (`ctx.Done()`). |
| `yield* range(ch, function* (r) { … })` | `for v := range ch` | `recv` until the channel is closed and empty. |
| `select([onRecv(ch), onSend(ch, v)], { default? })` → `{ i, ok, v, tok }` | `select` | One ready case runs; with several ready, the seed picks one, as Go does. None ready: `i: -1` with `default`, else it blocks on all cases. |
| `close(ch)` | `close(ch)` | Wakes every receiver with `ok: false`. A blocked sender panics. Closing twice panics. |
| `remake(ch)` | `ch = make(chan T, n)` on a variable that held an earlier channel | The node becomes a fresh, open, empty channel. Use it for a restart loop; nobody may still wait on the old channel. |
| `notify(ch, v)` | `signal.Notify`, `time.After` delivery | A send that never blocks: the value is dropped when the buffer is full. |
| `go(id)` | `go f()` | Starts a `spawned` goroutine: `go("closer")`, `go("worker[3]")`, `go("worker[*]")`. |
| `add(wg, n)`, `done(wg)`, `wait(wg)` | `sync.WaitGroup` | Counter; `wait` blocks until 0; below 0 panics. |
| `lock(mu)`, `unlock(mu)` | `sync.Mutex` | One holder. The next holder is any waiter: Go promises no order. Unlocking a free mutex is fatal. |
| `start(t)`, `reset(t)`, `stop(t)` | `time.NewTimer`, `Reset`, `Stop` | Arms, re-arms, or stops the timer. A tick nobody received is discarded (Go 1.23). |
| `cancel(ctx)` | `cancel()` | Closes `Done`; waiters wake. |
| `put(s, i, v)`, `append(s, v)` | `s[i] = v`, `s = append(s, v)` | Fills a slice cell. |
| `set(f, v)`, `inc(f, n)` | A measured fact | Sets or grows a fact node. |
| `print(v)` | `fmt.Println(v)` | The value flies to the output strip under the graph. |
| `pass(test)`, `fail(test)` | A test verdict | Marks a test at that moment. Mark it only where the real test can reach its verdict. |
| `panic(text)` | `panic` | The program crashes. |
| `exit(text)` | `os.Exit`, a fatal signal | Every goroutine ends at once. |

A value shows as Go source would write it, in at most 3 characters: `7`,
`t3`, `""`, `nil`. A value-less signal (`struct{}{}`) is `SIGNAL` from
`ops.ts`, drawn as a dot.

## What the scheduler derives

- Every state: running, working, blocked (and on what), returned, leaked,
  deadlocked, panicked. The author never writes a state.
- Every time. Channel operations take no time; only `work`, `sleep`,
  timers, and deadlines move the clock. While values move between nodes the
  clock stands still.
- The edges: a send draws goroutine → channel, a receive channel →
  goroutine, `go` a dotted "go" edge, `done`/`wait` dashed edges to the wait
  group, `close` a red dashed edge.
- The outcome and its sentence: "Leak: gen is blocked on out <- forever, with
  nobody left to wake it."
- Order. When several goroutines wake at one instant, a select has several
  ready cases, or a mutex has several waiters, a seeded random choice picks
  one. `check-visuals` runs 12 seeds; the outcome must not depend on the seed.

## Budgets

| What | Limit |
| --- | --- |
| Scenes | 1 today, 1 goal, 3 inside |
| Nodes per scene | 14 |
| Chip | 8 characters |
| Label | 14 characters |
| Work label | 16 characters |
| Test short name | 16 characters |
| Token value | 3 characters |
| Summary / insight / stop | 160 / 320 / 140 characters |
| Graph scale at a 640 px pane | at least 90 % (the graph fits nearly full size) |
| Graph scale at a 300 px pane | at least 60 % (the large view shows it whole) |

When nodes or names would overlap, the layout is computed wider and the
graph is drawn scaled down. `check-visuals` fails a scene that needs more
than the scales above: use fewer columns or rows, or fewer nodes.

## Worked example: 06, the Goal scene

```ts
model: {
  nodes: {
    caller: goroutine({
      label: "caller", pos: [0, 1], main: true,
      program: function* () {
        yield add("wg", N);          // Add before go: Add after go races with Done
        yield go("worker[*]");
        yield wait("wg");
      },
    }),
    wg: waitgroup({ label: "WaitGroup", pos: [1, 0] }),
    worker: goroutine({
      label: "worker", pos: [1, 1], count: N, base: 1, spawned: true,
      program: function* ({ i }) {
        yield work(K.latency.value, "ProcessImage");
        yield put("thumbnails", i, `t${i + 1}`);
        yield done("wg");
      },
    }),
    thumbnails: slice({ label: "thumbnails", pos: [2, 1], size: N }),
  },
  insight: "The caller starts one goroutine per URL, so all ten ProcessImage calls overlap. …",
  stops: [{ when: { op: "work", g: "worker", nth: N }, say: "Ten calls run at once. …" }],
  tests,
  clock: { unit: "ms", budget: { at: 500, label: "budget" } },
  expect: { outcome: "ok", t: 150, tests: { correctness: "pass", concurrency: "pass", race: "pass" } },
},
```

The Today scene has the same tests and clock, one `caller` that runs
`work(150, "ProcessImage")` then `append("thumbnails", …)` ten times, and the
scaffold's lines as code. Problem scenes on one door share one pace, so
Goal plays a tenth as long as Today, which is the lesson.

18 shows a knob: Goal is `(P) => Model` with
`knobs: [{ key: "cap", label: "cap(ch)", options: [0, 2, 20], value: 2 }]`, so
the learner can see that a buffer of 20 brings the gap back.

## Matching an event (`stops`)

`when: { op?, g?, node?, nth?, t? }`. `op` is an operation name, `"return"`,
`"fire"` (a timer or a deadline), `"end"`, or `"block"` (any operation that
blocked). `g` is a goroutine node id or a member (`worker[3]`). `node` is the
channel, wait group, mutex, timer, context, slice, or fact. `nth` counts
matches from 1. `t` matches at or after that time.

## Commands

From `web/`:

| Command | Does |
| --- | --- |
| `npm run viz -- new <id> [--today N] [--goal N]` | Writes the spec from the template, with both pins |
| `npm run viz -- pin <id> [--today N] [--goal N]` | Rewrites the pins after a README diagram edit |
| `npm run check-visuals [-- <id>]` | The checks above; exits 1 on any problem |
| `npm run test-visuals` | The engine's tests and the checker's planted faults |
| `npm run viz -- shots [<id> …]` | Screenshots of every scene's last frame at 300 and 640 px, light and dark, with overflow checks, plus a real-time motion check (thumb follows playback, no slow frames) |

From the repository root, `make lint` includes `viz-diagram`: every pin
matches a plain fence of the committed (or, in the commit gate, staged)
README.
