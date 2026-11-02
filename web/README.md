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

## Differences from running locally

| Local `go test -race` | In the browser |
|---|---|
| Race detector | **Not available.** It needs ThreadSanitizer, which WebAssembly cannot host. The UI tells the learner to run `go test -race` locally. |
| `GOMAXPROCS` = number of cores | 1. Goroutines switch only when one blocks, so `runtime.GOMAXPROCS(0)`-sized pools get one worker. |
| `os/exec`, `os/signal`, `os.Pipe` | Not available. The generator marks exercises that import `os/exec` or `os/signal` as unsupported (today: 04), and those exercises get a **Build** button instead of **Run tests**. |

## Commands

```sh
cd web
npm install
npm run dev        # prepare data + toolchain, then the Vite dev server
npm run build      # prepare + type-check + production build into dist/
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
