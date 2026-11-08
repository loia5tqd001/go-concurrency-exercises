# Go Concurrency Exercises in the browser

A static site that runs every exercise in the browser. Visitors read the problem, edit `main.go` in an editor with Go syntax highlighting, and run `go test -v`. They do not need to clone the repository, and no server runs their code.

## How it works

The site runs the real Go toolchain inside the browser. `cmd/compile` and `cmd/link` are built for `GOOS=js GOARCH=wasm`, and each run repeats what `go test` does:

```
main.go + check_test.go ──compile.wasm──▶ _pkg_.a ─┐
_testmain.go (generated at build time) ─compile.wasm─▶ _testmain.a ──link.wasm──▶ test binary (.wasm)
                                                                              │
                                              fresh Web Worker runs it ◀──────┘   output streams to the console
```

| Piece | File |
|---|---|
| Exercise code from `git HEAD`; docs from the working tree | `tools/gen/main.go` |
| Compiler, linker, stdlib archives, and gofmt, built as WebAssembly | `tools/goassets/main.go` |
| In-memory filesystem behind Go's `syscall/fs_js.go` | `src/runner/memfs.ts` |
| The compile and link pipeline, and running a binary | `src/runner/toolchain.ts`, `src/runner/go.ts` |
| Toolchain worker (builds) and runner worker (one per run, so Stop always works) | `src/runner/*.worker.ts` |
| UI: React + Monaco | `src/components/` |
| The star count beside the repository link, one API call a day per visitor | `src/stars.ts` |

## Banding the lines that matter

A Go fence can name the lines that carry the idea, so a reader skimming a long block sees which three lines are the change:

````
```go {6,12,23}
````

Numbers are 1-based from the first line of the block, and `{6,12-14}` and `{6 12}` work too. Those lines get a tinted band; every other line of that block steps back to 68% opacity. A fence with no `{...}` renders exactly as before, so this is opt-in per block.

`src/markdown.ts` turns the spec into `data-hl` and `wrapCodeLines` rebuilds the colorized block as one element per line. `src/components/Markdown.tsx` does that after Monaco colorizes, and again on every theme change, because colorizing replaces the markup. The band is `.md-line.hl` in `src/styles.css`.

## Copying a block

Every fence gets a Copy button in its top-right corner. It appears on hover or keyboard focus, and stays visible on a touch screen, which has no hover. `src/markdown.ts` wraps the fence in `.md-code-wrap`, which holds the button out of the scrolling `pre`, so the button stays in view when a long line is scrolled sideways. The click copies `data-src`, the fence's original text, because the colorized and banded markup does not round-trip to the source.

## Differences from running locally

| Local `go test -race` | In the browser |
|---|---|
| Race detector | **Not available.** It needs ThreadSanitizer, which WebAssembly cannot host. The UI tells the learner to run `go test -race` locally. |
| `GOMAXPROCS` = number of cores | 1. Goroutines switch only when one blocks, so `runtime.GOMAXPROCS(0)`-sized pools get one worker. |
| `os/exec`, `os/signal`, `os.Pipe` | Not available. The generator marks exercises that import `os/exec` or `os/signal` as unsupported (today: 04). They carry a `local` badge, use **Build only** instead of **Run tests**, and remain available under **All exercises**. |

## Visualisations

Some exercises have an animated visualisation. A spec, `src/viz/specs/<id>.ts`, is a small Go program: goroutine nodes with generator programs that yield one operation per Go statement (`send`, `recv`, `select`, `work`, `wait`, `lock`, `condWait`, …), plus the channels, wait groups, mutexes, condition variables, timers, contexts, slices, and facts they share. `src/viz/engine/sim.ts` runs the programs under Go's rules on a virtual clock and records every step; it decides every order (with a seeded random choice where Go promises none) and derives every state, the edges, and the outcome (ok, leak, deadlock, panic). `src/viz/engine/timeline.ts` turns the run into playback beats: the clock moves during work and stands still while values move between nodes. `src/viz/engine/layout.ts` places the nodes on the spec's grid and turns the grid top to bottom on a narrow pane. `src/viz/view/` draws the graph in SVG, with the transport, scrubber, knobs, tests, and a code panel whose gutter marks the line each goroutine is on. The registry, `src/viz/registry.ts`, globs `specs/[0-9]*.ts`, so a new spec needs no registry edit.

The sidebar opens on **Recommended**, a curated browser-runnable, visual-backed path through the system. **All exercises** keeps the complete numbered catalogue. Search always covers all exercises, and opening a non-recommended exercise switches the list to **All exercises**.

The language tests read every rendered exercise README, solution file, scene summary, insight, and stop caption. No prose sentence may exceed 20 words, and hard filler words are rejected. `npm run audit-language` prints the Markdown report for review.

The Problem tab mounts the player on the README's own ASCII diagram. The diagram stays the default view; a "▶ Today" or "▶ Goal" chip swaps in the animation at the same top edge, and the Diagram chip swaps the fence back. A spec pins one fence per Problem tier. Inside scenes appear at the top of the Solution tab after the existing reveal. In development, a stale pin shows its scenes below the README with a strip that says why; a production build omits them. The door plays on open; the Solution block starts paused; reduced motion never autoplays and jumps between steps instead of flying values.

`npm run check-visuals` proves each spec's constants and anchors against `git HEAD`, every `diagrams` pin against the working-tree README, code excerpts verbatim against the committed scaffold or the solution doc, no code in a goal scene, the vocabulary and spoiler rules for Problem scenes, the budgets, and a layout with no overlapping nodes at 300 and 640 px. It runs every scene, for every knob setting, under 12 seeds, and each run must end with the outcome, test results, and time the scene expects. `npm run test-web` adds the recommended-path contract, then tests the scheduler's Go rules and plants faults the checker must catch. `npm run check-layout` measures the exercise skeleton and loaded page in headless Chrome, so a late tab, badge, toolbar, or pane move fails the check. Run these after `prepare-data`.

`npm run viz -- shots [id ...]` renders every Problem and Solution scene at 300 px and 640 px, in light and dark, checks five points of each run, and saves the last frame under `node_modules/.cache/viz-shots/` (git ignores that path). It fails on horizontal overflow, a truncated label in the graph, or a control under 32 px. The command reuses a Vite server on :5173 and Chrome on :9222 when they are up; otherwise it starts and stops its own.

To add one, follow the `new-visualisation` skill and its `REFERENCE.md` (`.claude/skills/new-visualisation/`); they are the whole contract. `docs/visualiser-design.md` records why the engine is shaped this way.

The README ASCII diagram remains the clone-mode artifact. Do not replace it with the player.

## Exercise code comes from HEAD; docs come from the working tree

`scripts/prepare.sh` reads `.go` files from `git archive HEAD` and `.md` files (the root README, exercise READMEs, and solution docs) from the working tree. A README edit appears without a commit after the data regenerates. In `npm run dev`, the `go-concurrency-docs` Vite plugin regenerates on save and reloads the page; `make web-data` does the same on demand.

Code stays from HEAD because the owner keeps solved `main.go` files uncommitted, and the site must never publish them. The pre-commit gate refuses a commit that leaves an exercise README with unstaged changes, so the deployed site and the clone still receive the doc when you commit.

## Link previews

Slack, LinkedIn and X read the tags in the head of `index.html`. They do not
run JavaScript, so those tags are static: every route previews as the same
card, and only the root URL's own copy is what a crawler sees.

The card image is built rather than drawn by hand. `og/card.html` holds the
layout, and `scripts/og.ts` fills in the exercise count, the Go version and
the exercise list from `src/generated/exercises.json` — the same file the site
builds from — then screenshots the page at 1200x630 with headless Chrome.

```sh
npm run og        # after adding, renaming or reordering an exercise
```

`public/og.png` is committed. Crawlers fetch it from the deployed site, and
the Vercel build image has no Chrome, so regenerate it on a machine that does.
Vercel serves it from the filesystem before the SPA rewrite, like
`favicon.svg`. `og:image` must be an absolute URL, so both the tags and the
card's own address are pinned to the production domain; a preview deployment
therefore advertises the production image.

## Commands

Node 22 or newer is required; the scripts run TypeScript directly.

```sh
cd web
npm install
npm run dev        # prepare data + toolchain, then the Vite dev server
npm run build      # prepare + type-check + production build into dist/
npm run og         # rebuild public/og.png, the link-preview card
npm run smoke      # every scaffold through the runner under Node; each must build and fail its tests
npm run smoke -- --solutions ..   # your local main.go files instead; each must pass
npm run audit-language            # report long or hard-to-read prose across exercise and solution Markdown
npm run test-web   # recommended-path contract and visual-engine tests
npm run check-layout              # loading and loaded page geometry must match
npm run viz -- shots              # pixel check every spec; PNGs under node_modules/.cache/viz-shots
npm run viz -- shots 06           # pixel check one spec, by id or leading number
npm run viz -- shots 06 --themes light   # just the light review frames
```

`scripts/prepare.sh` runs before `dev` and `build`. It needs Go at the version in the root `go.mod`. If `go` is not on `PATH` (as on Vercel), the script downloads that version itself.

## Deploy to Vercel

Two `vercel.json` files exist, because Vercel reads the one that sits in the
directory you set as the project's Root Directory, and each root needs
different paths:

| Root Directory | Config Vercel reads | Install command |
|---|---|---|
| repository root | `vercel.json` | `cd web && npm ci` |
| `web` | `web/vercel.json` | `npm ci` |

Vercel's import screen pre-selects `web`, because that is where the Vite app
lives. Either choice deploys correctly, so you do not need to change anything.

1. Push the repository to GitHub.
2. In Vercel, import the repository.
3. Deploy. Each push to `main` deploys again.

The build reads exercises from the commit that Vercel checked out, so only committed files are published. A plain `vercel deploy` from your machine uploads files without `.git`, and the generator then stops with an error. This prevents a local `main.go` solution from being published by accident. To deploy from the CLI, run `vercel build` and then `vercel deploy --prebuilt`.

`package-lock.json` can record a private npm mirror. `.npmrc` sets `replace-registry-host=always`, so every install fetches from the registry that the installer has configured. On Vercel, that is the public npm registry.
