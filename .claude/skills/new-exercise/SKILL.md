---
name: new-exercise
description: Author a new exercise (or redesign an existing one in place) for this go-concurrency-exercises repo, following the repo's visual/concise/barebone style. Use when the user says "/new-exercise", "add exercise N", "create a new problem about X", or asks to redesign an exercise's scaffold because it gives away too much of the solution.
---

# New Exercise

Creates (or redesigns in place) one exercise folder: `README.md`,
`main.go`, `check_test.go`, optional mock helpers, and a matching
`solutions/NN-*.md` spoiler writeup — then syncs the root `README.md`
table.

## Project mission

Every exercise in this repo is judged against all seven of these, not
just the ones that are convenient this time:

1. **Visual** — README.md uses an ASCII diagram of the today-vs-goal
   shape, not just prose.
2. **Concise** — no padding; every sentence in the README earns its
   place.
3. **Barebone** — `main.go` teaches by making the solver invent the
   real mechanism, not patch a near-complete one. See
   [REFERENCE.md](REFERENCE.md)'s barebone-scaffold rule, which exists
   because exercises 36 and 37 originally handed out near-complete
   implementations that only needed a mutex bolted on.
4. **Real-world, not contrived** — the scenario must be something that
   actually happens in production Go code (a real API shape, a real
   failure mode), and the reference solution must be clean: no leaked
   goroutines, no leaked channels/timers, proper shutdown — "make it
   pass the test" is not the bar, "would this pass code review" is.
   See REFERENCE.md's "Real-world framing and goroutine hygiene".
5. **Strict tests** — `check_test.go` must actually catch the
   concurrency bug, not just the happy path, and must catch it
   reliably (see REFERENCE.md's "Verify the test actually catches the
   bug").
6. **Solutions with alternatives** — `solutions/NN-*.md` presents more
   than one valid approach where more than one genuinely exists, with
   the tradeoff between them explained, not just one path to green
   tests. See REFERENCE.md's "Alternative approaches in solutions docs".
7. **Curriculum coverage** — new exercises should close a gap (a
   primitive or a real-world pattern not yet taught), not duplicate one
   already covered. See REFERENCE.md's "Checking curriculum coverage"
   before locking in the topic.

## Steps

1. **Scope the exercise.** Get from the user (or infer and confirm): the
   concurrency lesson, the real-world scenario framing it, the pinned
   function/method signatures, and whether this is a new number, a
   lettered sequel (`14b`, `16b`, `33b` style — same lesson, harder
   variant, see those folders), or an in-place redesign of an existing
   exercise (18 and 36 were both redesigned in place rather than given
   a lettered sequel — ask the user which they want if it's ambiguous).
   Check curriculum coverage (mission #7) before locking in the topic —
   see REFERENCE.md.

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
   against a subtly-wrong solution. Cover the concurrency bug itself
   (mission #5), not just functional correctness — a deterministic test
   that doesn't depend on scheduling luck where one is possible (see
   37's "submit after Close has already returned" test), plus a
   `-race`-reliant test for the messier concurrent-overlap case.

5. **Verify empirically, don't guess — against BOTH ends.** From the
   repo root: `gofmt -l <folder>`, `go vet ./<folder>/...`, then
   `go test -v ./<folder>/...` and `go test -race ./<folder>/...`
   against the naive scaffold — confirm it fails, *fast* (sub-second to
   a few seconds, never hanging toward Go's default 10-minute timeout).
   Then temporarily write the reference fix in `main.go`, rerun both,
   confirm everything passes clean including `-race` (repeat with
   `-count=20` if timing-sensitive) with zero goroutine leaks, and only
   *then* revert to the naive scaffold. Skipping the fixed-version pass
   is how untested exercises ship with a second, unintended bug baked
   into the "already correct" parts of the naive code.

6. **Write `solutions/NN-*.md`** — spoiler warning banner, then "The
   problem" quoting main.go's actual naive code verbatim plus the
   *actual* `go test` failure output from step 5 (never fabricate this
   output), then "The fix" walking the real design, then — per mission
   #6 — any other genuinely valid approach with the tradeoff explained
   (not a second approach invented just to pad the doc; see
   REFERENCE.md). A solved `main.go` is never committed to this repo
   (only the scaffold is) — if a solution already exists locally,
   uncommitted, in that folder, you may use it to write this section,
   but strip it back to the *shape* of a fix, not the user's literal
   private code, and never `git add` or commit that file.

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
