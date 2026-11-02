# Working in this repo

This repo teaches Go concurrency. Each numbered folder (`00-…` to `39-…`,
plus lettered sequels like `14b-…`) is one exercise: `README.md`, a naive
`main.go` that the learner fixes, `check_test.go`, optional `mock*.go`, and a
worked solution in `solutions/<folder>.md`. `web/` runs the same exercises
in the browser (see `web/README.md`).

## The rule behind the other rules

The committed `main.go` is the unsolved scaffold. The owner's checkout keeps
solved `main.go` files as uncommitted changes, and no other copy of them
exists. So:

- Never commit a solved `main.go`. The commit gate refuses a `main.go` that
  passes its own tests.
- Never overwrite the owner's uncommitted work. The edit guard refuses an edit
  to an exercise file with local changes until you back it up.

## Commands

| Command | What it proves | Run it |
| --- | --- | --- |
| `make setup` | Installs the commit gate | Once per clone |
| `make lint` | Static rules below | After any edit (the stop guard runs it too) |
| `make gen` | Rewrites the README sections derived from the overview table | After you edit the overview table |
| `make verify EX=36` | Your scaffold builds and fails its tests 10 times in 10, fast | After you change a scaffold or a test |
| `make try EX=36 MAIN=/tmp/ref.go` | A candidate solution passes 20 runs with `-race`, in a temp copy | To prove the tests accept a correct solution |
| `make check` | Everything the commit gate checks | Before you commit |
| `cd web && npm run smoke` | Every scaffold builds and fails in the browser runner | After you change `web/` or a test |

## Guardrails

| Guard | Where | What it stops |
| --- | --- | --- |
| Commit gate | `.githooks/pre-commit` → `tools/check precommit` | Lint failures; a staged exercise whose scaffold passes its own tests (a solution), does not build, or hangs; a staged file with newer unstaged edits (the `git mv` + edit trap) |
| Edit guard | Claude Code hook → `tools/check hook edit` | An edit to an exercise file that has local changes this session did not make |
| Git guard | Claude Code hook → `tools/check hook bash` | `git add -A`/`.`/`-u`, `commit -a`, `--no-verify`, `reset --hard`, `clean -f`, `checkout`/`restore` over local changes, plain force push, changes to `core.hooksPath` |
| Stop guard | Claude Code hook → `tools/check hook stop` | Finishing a session that edited files while `make lint` fails (blocks once) |
| CI | `.github/workflows/check.yml` | The same checks on every push, plus the web smoke test |

When a guard blocks you, read its message: it says what to do instead. Do
not look for a way around it. If the owner really wants the blocked action,
ask them to run it as `! <command>`.

To edit a file that holds the owner's work, back it up first:
`mkdir -p .wip-backup/36-batch-collector && cp 36-batch-collector/main.go .wip-backup/36-batch-collector/`.
Commit only the scaffold, then copy the backup back.

## Lint rules

| Rule | Requires |
| --- | --- |
| `layout` | Every exercise has `README.md`, `main.go`, `check_test.go`, and `solutions/<folder>.md`; exercise folders hold only `.go` files and `README.md`; no orphan solution docs |
| `gofmt`, `package` | Exercise and tool code is gofmt-clean and in `package main` |
| `browser` | No `os/exec`, `os/signal`, `os.Pipe`, `runtime.NumCPU`, or `runtime.GOMAXPROCS`; the browser runner cannot support them |
| `test-header` | `check_test.go` has the `DO NOT EDIT THIS PART` header |
| `readme-title`, `readme-test-section`, `readme-diagram` | The README has a title, a "Test your solution" section, and an ASCII diagram |
| `doc-tests` | Every `TestXxx` that a README or solution doc names exists in that exercise's tests |
| `solution-doc` | The solution doc has the spoiler banner |
| `overview` | One well-formed row per exercise in the root README table, in folder order |
| `sequel-tier` | A lettered sequel is never rated easier than its parent |
| `generated` | The topic index and `solutions/README.md` match the overview table |
| `skills` | Each `.claude/skills/<name>` has a `.agents/skills/<name>` symlink |

## Common tasks

- Add or redesign an exercise: follow the `new-exercise` skill
  (`.claude/skills/new-exercise/SKILL.md`).
- Review a solution: follow the `judge` skill.
- Change a title, a difficulty, or a topic: edit only that row of the
  overview table in `README.md`, then run `make gen`.

## When you learn a lesson

Put it where the next agent cannot miss it. In order of preference:

1. A rule in `tools/check` (`lint.go` for static rules, `run.go` for test
   runs), with a message that says how to fix the problem.
2. A step in a skill (`.claude/skills/*/SKILL.md` or `REFERENCE.md`).
3. A sentence in this file, only if 1 and 2 do not fit.

`exceptions` in `tools/check/lint.go` lists known violations, each with a
reason. Delete an entry when you fix its violation. Never add an entry to
make your own change pass; ask the owner.
