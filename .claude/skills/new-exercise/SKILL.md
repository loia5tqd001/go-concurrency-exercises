---
name: new-exercise
description: Author a new exercise (or redesign an existing one in place) for this go-concurrency-exercises repo, following the repo's visual/concise/barebone style. Use when the user says "/new-exercise", "add exercise N", "create a new problem about X", or asks to redesign an exercise's scaffold because it gives away too much of the solution.
---

# New Exercise

Creates (or redesigns in place) one exercise folder: `README.md`,
`main.go`, `check_test.go`, optional mock helpers, and a matching
`solutions/NN-*.md` spoiler writeup — then syncs the root `README.md`
table. Grounded in [REFERENCE.md](REFERENCE.md)'s barebone-scaffold rule,
which exists because exercises 36 and 37 originally handed out
near-complete implementations that only needed a mutex bolted on.

## Steps

1. **Scope the exercise.** Get from the user (or infer and confirm): the
   concurrency lesson, the real-world scenario framing it, the pinned
   function/method signatures, and whether this is a new number, a
   lettered sequel (`14b`, `16b`, `33b` style — same lesson, harder
   variant, see those folders), or an in-place redesign of an existing
   exercise (18 and 36 were both redesigned in place rather than given
   a lettered sequel — ask the user which they want if it's ambiguous).

2. **Write `main.go` bare** — see REFERENCE.md's "Barebone scaffold"
   section before writing a single line. The test in your own head:
   *could a solver pass every test by adding only 1-2 sync primitives
   to what's given?* If yes, the scaffold is too generous — strip
   further. Compare against `35-singleflight/main.go` as the reference
   bar for "genuinely bare."

3. **Write `README.md`** — visual (ASCII diagram of the today-vs-goal
   shape, like `36-batch-collector/README.md`'s), concise, ending with
   a "Your task" section that pins the exact signatures and a "Test
   your solution" section (`go test`, `go test --race`). The "right
   now, here's what's broken" prose must describe main.go's *actual*
   stub, not an imagined fuller one — copy-check this against the real
   file before moving on.

4. **Write `check_test.go`** — `DO NOT EDIT THIS PART` header. Every
   receive from a channel the solution controls needs a
   `select { case ...; case <-time.After(timeout): t.Fatalf(...) }`
   guard — REFERENCE.md's "Fast-failing tests" section explains why
   this matters more than usual against a bare scaffold, not just
   against a subtly-wrong solution.

5. **Verify empirically, don't guess.** From the repo root:
   `gofmt -l <folder>`, `go vet ./<folder>/...`, then
   `go test -v ./<folder>/...` against the naive scaffold you just
   wrote. Confirm it fails — every test should fail *fast* (sub-second
   to a few seconds), not hang toward Go's default 10-minute test
   timeout. If any test hangs, that's a scaffold or harness bug — fix
   it now (see REFERENCE.md), don't ship it.

6. **Write `solutions/NN-*.md`** — spoiler warning banner, then "The
   problem" quoting main.go's actual naive code verbatim plus the
   *actual* `go test` failure output from step 5 (never fabricate this
   output), then "The fix" walking the real design. A solved `main.go`
   is never committed to this repo (only the scaffold is) — if a
   solution already exists locally, uncommitted, in that folder, you
   may use it to write this section, but strip it back to the *shape*
   of a fix, not the user's literal private code, and never `git add`
   or commit that file.

7. **Sync the root `README.md` table** — add/update the row (number,
   title linking to the folder, difficulty badge, topic tags), matching
   the existing badge/tag style exactly (grep the table for the closest
   difficulty neighbor before picking one).

8. **Cross-check the trio.** `main.go`'s header comment, `README.md`'s
   "right now" section, and `solutions/NN-*.md`'s "The problem" section
   all describe the same starting code — read all three back to back
   and confirm they agree. This is the single most common drift point
   when an exercise gets edited once and not fully.

## Redesigning an existing exercise in place

Same steps, but also: check `git diff`/`git status` for any uncommitted
solution sitting in that folder's `main.go` before you overwrite it —
back it up (copy aside) so it can be restored after you commit the new
scaffold, per this repo's rule that a solved `main.go` never gets
committed. Re-run step 5 against the new scaffold specifically (an old
solution's test pass doesn't tell you the new scaffold fails correctly).
