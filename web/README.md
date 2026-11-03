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
| Exercise data, read from `git HEAD` only (never your local `main.go`) | `tools/gen/main.go` |
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

## Differences from running locally

| Local `go test -race` | In the browser |
|---|---|
| Race detector | **Not available.** It needs ThreadSanitizer, which WebAssembly cannot host. The UI tells the learner to run `go test -race` locally. |
| `GOMAXPROCS` = number of cores | 1. Goroutines switch only when one blocks, so `runtime.GOMAXPROCS(0)`-sized pools get one worker. |
| `os/exec`, `os/signal`, `os.Pipe` | Not available. The generator marks exercises that import `os/exec` or `os/signal` as unsupported (today: 04), and those exercises get a **Build** button instead of **Run tests**. |

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

```sh
cd web
npm install
npm run dev        # prepare data + toolchain, then the Vite dev server
npm run build      # prepare + type-check + production build into dist/
npm run og         # rebuild public/og.png, the link-preview card
npm run smoke      # every scaffold through the runner under Node; each must build and fail its tests
npm run smoke -- --solutions ..   # your local main.go files instead; each must pass
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
