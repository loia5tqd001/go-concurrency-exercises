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

## Real-world framing and goroutine hygiene

The scenario has to be something that actually happens in production
Go — a real API shape (batch endpoints that charge per round-trip, a
graceful-shutdown race on a job queue, a cache-stampede), not a puzzle
invented to justify a primitive. If you can't name a real system that
has this exact shape (a stdlib package, a well-known library, a
pattern from a real production codebase), the framing is contrived —
rework it before writing anything else. 36 and 37 are both explicitly
modeled on real internal package patterns (a Kafka-producer-style
batching client, a `net/http.Server.Shutdown`-shaped `Close`); 35 and
17 point readers at the real `golang.org/x/sync` packages they mirror.

The reference solution you verify in step 5 must be clean, not just
passing: every goroutine started has a way to exit (closed channel,
`ctx` cancellation, bounded work — no goroutine that outlives the test
with nothing left to do), every channel is closed exactly once by its
owning goroutine, and every `time.Timer`/`time.Ticker` gets `Stop()`'d
once it's no longer needed. `go test -race` catches data races, not
leaks — if the exercise's lifecycle is nontrivial (goroutines whose
exit depends on a signal, not just running to completion), consider a
goroutine-count assertion in `check_test.go` (`runtime.NumGoroutine()`
before/after, with a settle delay) or `testing/synctest` (see 05, 09,
17's tests) so a leak fails the suite instead of just leaking quietly
in production later.

## Verify the test actually catches the bug

A test suite that passes against both the naive scaffold's *intended*
failure and the reference fix, but was never checked to actually FAIL
against the naive scaffold, might be testing the wrong thing entirely.
Step 5 requires running the suite against both ends for exactly this
reason — a test passing against a broken implementation is a bug in
the test, not evidence the implementation is fine.

Timing-based races are the sharp edge: a test that merely spins up N
goroutines and hopes they race can pass clean against a genuinely
racy implementation on a fast/many-core machine, especially without
`-race`. Two techniques from this repo's history:

- **Prefer a deterministic reproduction over a timing-dependent one**
  where the bug allows it. 37's `TestSubmitAfterCloseIsRejectedNotPanicked`
  submits jobs, waits for `Close` to fully return, *then* submits again
  — there is no scheduling luck left, the naive version panics on every
  single run. Keep a separate `-race`-reliant test for the messier
  genuinely-concurrent-overlap case, but don't rely on it alone.
- **Turn up contention until it's reliable**, if no deterministic
  reproduction exists (e.g. a check-then-act race under real
  concurrency). Exercise 38 needed 4000 goroutines / 200 stock / 5
  rounds before the naive version failed 10/10 even *without* `-race`
  — 500 goroutines wasn't enough. When a race test is flaky against a
  known-broken implementation, the fix is usually more contention, not
  a `-race`-only test.

## Alternative approaches in solutions docs

`solutions/NN-*.md` should present more than one valid approach only
where more than one genuinely, meaningfully exists — a second approach
invented just to pad the doc is worse than no second approach. Good
precedent in this repo:

- 35's dedup key-cache: a `done`-channel broadcast per key vs.
  `sync.OnceValue` keyed by a map — genuinely different mechanisms,
  same guarantee.
- 38's decrement: `atomic.CompareAndSwap` retry loop (the taught
  approach) vs. `atomic.AddInt64` with a compensating rollback on
  failure — the doc explains *why* the second one happens to work for
  this one fixed-decrement case but doesn't generalize, which is the
  actual lesson, not just "here's another way."
- 37's `RWMutex`-held-across-the-send design vs. a plain `Mutex`
  released before the send, correct only because a `WaitGroup`
  transitively gates the channel close — worth including specifically
  *because* the second one looks subtly wrong at a glance and isn't.

If a second approach exists but is strictly worse with nothing to
learn from the comparison (more code, no different tradeoff), leave it
out — mission #6 is about explaining a genuine tradeoff, not about
approach-count.

## Checking curriculum coverage

Before locking in a new exercise's topic, check the root `README.md`'s
[Browse by topic](../../../README.md#browse-by-topic) table for what's
already covered and by how many exercises — a topic with one or two
entries is a thinner area than one with six. Precedent for gap-driven
additions: exercise 38 was added after `grep -rl "CompareAndSwap\|atomic\."`
across the repo showed every prior `sync/atomic` use was just
`Add`/`Load` on a counter, with no exercise practicing the CAS
retry-loop idiom; 33/34 were ported from Rob Pike's 2012 "Go
Concurrency Patterns" talk after comparing this repo against that
talk's demo programs turned up missing patterns (self-scheduling load
balancer, concurrent prime sieve — chat-roulette and concurrent power
series from the same talk are still open gaps). Auditing a real
production codebase's concurrency package for patterns not yet taught
(as 36/37 were sourced) is another reliable way to find a genuine gap
rather than inventing a topic for its own sake.

## Difficulty rubric

Difficulty badges drift out of calibration fast if each exercise gets
eyeballed in isolation against whatever number happens to be nearest —
that's exactly how exercise 39 ended up rated `medium` (correct for a
33/33b derivative) and stayed `medium` after being redesigned standalone,
where the actual solver work is `easy`-tier. Score every exercise
against these 5 dimensions instead, each 0-3 (0 = none/trivial, 1 =
low, 2 = moderate, 3 = high):

- **A. Mechanism count** — how many distinct sync primitives/idioms
  (mutex, atomic/CAS, channel-select, `sync.WaitGroup`, `sync.Once`,
  timer, context) must the solver correctly combine in their *own*
  fix? Count only what the solver must apply — not machinery already
  given/inherited from an earlier exercise's lesson (see the barebone
  section above on telling the two apart).
- **B. Trigger/race multiplicity** — how many independent
  goroutines/timers/events can race to cause the *same* effect
  (double-fire, double-close, lost update) that the fix must
  arbitrate between? 0 = no such race. 1 = a plain data race needing a
  lock. 2 = two competing triggers needing a "first one wins" answer.
  3 = three or more triggers all needing exactly-once semantics.
- **C. Solver-authored surface area** — how much of the exercise's
  *own* control flow must the solver write from scratch? 0-1 = patch a
  single function body / add one guard. 2 = write a full method's
  control flow (a loop + goroutine + synchronization placement). 3 =
  design a new composite type with its own lifecycle, used across
  multiple methods.
- **D. Trap subtlety** — score the trap a solver hits on the *path of
  least resistance* (the fix most solvers reach for first), not the
  most subtle trap the solutions doc happens to document. A single
  well-known idiom applied directly (0-1), one documented near-miss
  trap that looks correct but isn't *and that the natural first
  attempt actually walks into* (2), or multiple compounding traps/edge
  cases on that natural path (3). A trap that only catches someone
  deliberately trying a fancier optimization doesn't count — score
  what the obvious fix runs into, not what an advanced one might.
- **E. Shutdown/lifecycle burden** — 0 = no shutdown concern at all. 1
  = a simple one-time `Close` with no concurrency concern. 2 = `Close`
  must coordinate with in-flight work but only one caller/trigger. 3 =
  `Close` must be safe under concurrent/repeated calls and possibly a
  `ctx` deadline, racing against other in-flight triggers.

**Anchor exercises** — fixed reference points, not up for re-debate.
Place every new exercise relative to these by re-reading them if
you're unsure, rather than guessing from memory:

| Tier | Anchor | Typical scores (A/B/C/D/E) |
| --- | --- | --- |
| warm-up | [00-limit-crawler](../../00-limit-crawler) | 1/0/0-1/0/0 |
| easy | [04-graceful-sigint](../../04-graceful-sigint) | 1/0-1/0-1/0-1/0-1 |
| medium | [10-semaphore](../../10-semaphore) | 1-2/0-1/2/0-1/0-1 |
| hard | [13-channel-of-channels](../../13-channel-of-channels) | 2/1-2/2-3/2/0-2 |
| extreme | [36-batch-collector](../../36-batch-collector) | 3/3/3/3/3 |

**The tier is primarily set by whichever single dimension scores
highest** — a single maxed-out dimension (e.g. a 3-way race, or a
`Close` that must be concurrent-safe under a `ctx` deadline) can make
the whole exercise that hard on its own. Don't average the five scores
together; use them as supporting evidence for a holistic placement
against the anchors, and say so explicitly if an exercise is genuinely
borderline between two tiers rather than forcing a confident pick.

**Lettered sequels never score below their parent.** `14b`/`16b`/`33b`
are defined as "same lesson, harder variant" (see SKILL.md step 1) —
that's a structural guarantee, not just a naming convention. If scoring
a sequel in isolation suggests a lower tier than its parent (e.g. its
own new surface is small because it builds on already-correct inherited
machinery), that means the *parent's* tier is the one worth
re-examining, or the sequel should floor at the parent's tier — never
publish a sequel rated easier than the exercise it follows.

## Root README table

Keep row formatting identical to neighbors: `| N | [Title](./NN-folder) |
![difficulty](badge-url) | \`tag\` \`tag\` |`. Difficulty badges in use:
`warm-up` (grey), `easy` (green), `medium` (blue), `hard` (orange),
`extreme` (red) — pick using the rubric above, not by guessing.
Lettered sequels (`14b`, `16b`, `33b`) sit directly after their parent
row.
