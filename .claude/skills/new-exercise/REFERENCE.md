# Reference

## Barebone scaffold

`main.go` is the only file a solver is asked to edit. Everything it
already contains is work the solver *doesn't* have to do — so anything
pre-built that isn't the actual lesson quietly narrows the exercise
down to "patch this one gap."

Exercises 36 and 37 originally shipped this way: 37's `Submit`/`Close`
already had the exact right shape (unbuffered channel, `sync.WaitGroup`
for completion tracking) and only needed a mutex-guarded `closed` flag
bolted on. 36's `Add`/`execute` already did the full single-threaded
batching logic (append, threshold check, fan-out) and only needed
synchronization added. Both could be "solved" by a mechanical patch
without designing anything — the actual lesson (safe shutdown
coordination; a rolling batcher's data model) never had to be invented
by the solver, just recognized and wired in.

**The fix, applied to both:** strip `main.go` down to:

- The struct type, with only fields that don't give away the design
  (often empty, or just the immutable config/callback the constructor
  receives — see `35-singleflight/main.go`'s `type Group struct{}`,
  `36-batch-collector/main.go`'s `Collector{cfg, fn}` after the redesign,
  `37-safe-pool-shutdown/main.go`'s `Pool{jobs chan func()}` after it).
- The pinned function/method signatures from the README's "Your task"
  section — these can never change, tests depend on them.
- A body that is **genuinely, trivially wrong** — not "wrong because
  it's missing a lock," but wrong in a way that requires the solver to
  invent the actual mechanism. Compare:
  - 35's `Do`: calls `fn` directly, no dedup, no memoization — the
    entire "in-flight sharing" idea doesn't exist yet.
  - 37's `Submit`/`Close` after the fix: no `WaitGroup`, no mutex, no
    `closed` field — just an unbuffered send and a bare `close()`. The
    solver must invent *both* the completion-tracking and the
    shutdown-guard, not just the second one.
  - 36's `Add` after the fix: calls `fn` once per single request, no
    batching at all — not "batching but racy," actually not batching.

**The test that catches an over-generous scaffold:** could a solver
pass every hidden test by adding only 1-2 sync primitives (a mutex, an
atomic, a `sync.Once`) to what's already there, without inventing any
new data flow or control structure? If yes, strip further. A good
barebone scaffold usually means the solved `main.go` looks
*substantially* different in shape from the scaffold, not just
"the same code plus a lock."

**Don't over-strip the wrong thing, though.** Machinery that's the
subject of an *earlier* exercise, not this one, is fine to keep
pre-built — re-deriving it here would just retest an old lesson instead
of teaching the new one. Example: 37 keeps `NewPool`/`worker()` spawning
goroutines off a shared channel intact, because exercise 11
(`11-worker-pool`) already is the "build a worker pool from scratch"
lesson; 37's lesson is specifically the `Submit`/`Close` shutdown race,
so only *that* part gets stripped bare. Ask: "is this specific piece of
given code the thing this exercise is teaching, or infrastructure a
prior exercise already covered?" — strip the former, keep the latter.

## Fast-failing tests

`check_test.go` has a `DO NOT EDIT THIS PART` header for solvers, but
you (authoring or redesigning the exercise) can and should edit it.

Every blocking receive from something the *solution* controls — a
channel `Add`/`Submit`/`Do`/etc. returns, or the call to that method
itself if it can plausibly block synchronously — needs a bounded
`select`/`time.After` guard, or a helper like `36-batch-collector`'s
`recvResult`/`addWithTimeout`. Without one, a naive or subtly-wrong
solution doesn't fail fast — it hangs until Go's default 10-minute
`-timeout`, which is a miserable solver experience and makes `go test`
look broken rather than the code.

This bites hardest exactly where a bare scaffold (see above) makes a
method call itself synchronous when the eventual correct solution is
supposed to make it non-blocking (e.g. a batch that should fire in the
background). Guard the *call*, not just what it returns — see
`36-batch-collector/check_test.go`'s `addWithTimeout`, added after a
bare `Add` stub turned `TestCollectorCloseRespectsContextDeadline` into
a 10-minute hang because the test called `c.Add(...)` directly with no
timeout around the call itself.

Verify this empirically before shipping: run `go test -v ./<folder>/...`
(no `-timeout` override) against the scaffold you just wrote, and
confirm every test reports a `FAIL` within a few seconds. If one is
still running after ~5s, it's not bounded — fix the test, not just the
scaffold.

## Keeping the trio in sync

Three places describe the same "here's what's broken today" moment:

1. `main.go`'s header comment (the big `//` block at the top).
2. `README.md`'s "Right now, X does..." section.
3. `solutions/NN-*.md`'s "The problem" section (code block + verified
   failure output).

Editing `main.go`'s scaffold without updating the other two is the most
common way this repo's docs drift stale — it happened to exercises 36
and 37 mid-redesign in this same session. When you touch any one of
these three, re-read all three back to back before moving on.

The "Verified" output in `solutions/NN-*.md` must be copy-pasted from
an actual `go test` run against the actual checked-in scaffold, not
written from memory or extrapolated — re-run it after any scaffold
change, even a small one, since exact line numbers, counts, and error
text in the output are load-bearing (a stale `check_test.go:68` after
the test file gets edited is an easy tell that the doc wasn't
regenerated).

## Root README table

Keep row formatting identical to neighbors: `| N | [Title](./NN-folder) |
![difficulty](badge-url) | \`tag\` \`tag\` |`. Difficulty badges in use:
`warm-up` (grey), `easy` (green), `medium` (blue), `hard` (orange) —
match by comparing the new exercise's actual challenge to its nearest
neighbors, not by guessing. Lettered sequels (`14b`, `16b`, `33b`) sit
directly after their parent row.
