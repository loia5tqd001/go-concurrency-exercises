---
name: new-visualisation
description: Add or update the animated visualisation for one exercise in this go-concurrency-exercises repo. A spec is a small Go program (goroutines as generator programs, channels, wait groups, mutexes, timers) that a scheduler runs and a graph view animates. Use when the user says "/new-visualisation", "add a visualisation for exercise N", "animate exercise N", or asks why a spec fails `npm run check-visuals`.
---

# New Visualisation

A visualisation is one file: `web/src/viz/specs/<exercise-id>.ts`. It
describes a small Go program. Each goroutine node has a program, written as a
generator that yields one operation per Go statement (`send`, `recv`,
`work`, `wait`, …). The scheduler in `web/src/viz/engine/sim.ts` runs the
programs under Go's rules and decides every order and every time. The view
draws the result as a graph: goroutines and channels as nodes, values as
tokens that fly along the edges, blocked goroutines in amber, leaks in red.

The README's own ASCII diagram is the door. A "▶ Today" or "▶ Goal" chip
replaces the diagram in place with the animation, and the "Diagram" chip
swaps it back. Inside scenes sit at the top of the revealed solution.

**This file and [REFERENCE.md](REFERENCE.md) are the whole contract.** Read
REFERENCE.md before you write a scene: it has the node kinds, the
operations, the grid, the scene fields, the budgets, and a worked example.

## The rule that outranks the others

**Truth first.** The animation is a model of a real run. Every goroutine,
channel, and number in it must exist in the code it models, at the time it
shows. If a budget or a missing operation forces a lie, stop and report it.
Do not bend the program to fit.

**Do not choose a design default.** If this contract is silent on something
design-facing (a colour, a new node kind, a new operation, placement, a
budget), stop and report the gap. Do not edit the engine, the view, or the
CSS to make one spec work.

## Steps

1. **Read the exercise.** The README from the working tree. The code from
   HEAD only, because the owner keeps solved `main.go` files uncommitted:
   `git show HEAD:<id>/main.go`, `git show HEAD:<id>/check_test.go`, and every
   `mock*.go`. Read `solutions/<id>.md` for the inside scenes.

2. **Choose the scenes.** At most one of each Problem tier, three inside.

   | Tier | Shows | Where | Code panel |
   | --- | --- | --- | --- |
   | `today` | What the committed scaffold does, and why a test fails | Problem tab, on the README diagram | Scaffold lines, verbatim |
   | `goal` | The shape the README promises, at the README's level of detail | Problem tab, on the README diagram | None: the Problem tab must not show the answer |
   | `inside` | How the solution works, and the traps | Solution tab, after the reveal | Solution lines, verbatim |

   A scene models **one run**: `main()` or one named test. Its numbers and
   names come from that run.

3. **Create the file.** `cd web && npm run viz -- new <id>`. It copies
   `_template.ts` and writes both README pins. If the README has several
   diagram fences, it lists them; pass `--today N --goal N`.

4. **Write the constants.** Every duration and count names its source line:
   `{ value: 150, file: "mockimageprocessor.go", text: "const ProcessingLatency = 150 * time.Millisecond" }`.

5. **Place the nodes.** Data flows left to right: `pos: [column, row]`.
   Sources in column 0, sinks in the last column. Shared objects (a wait
   group, a fact) above or below the flow. Use the README's and the code's
   own names as labels. One goroutine is one node in every scene of the
   spec: name it by who it is ("caller"), not by its role in one scene.

6. **Write the programs.** One operation per Go statement, in the order the
   code runs them. Use real durations from the constants. Mark the caller
   `main: true`. A goroutine that another one starts gets `spawned: true`
   and starts with `go("id")`.

7. **Write the tests and the expectation.** Each test has its full Go name,
   a short name, and a `judge` on the finished run, or a program marks it
   with `pass()`/`fail()`. `expect` names the outcome, the test results, and
   the end time when time is the lesson.

8. **Write the words.** `insight`: one or two sentences under the graph,
   what to watch and why. `stops`: optional pauses with a caption at the
   moments that matter, at most three. Use plain words; name no identifier
   that only the solution declares.

9. **Run the checks** from `web/`:

   ```
   npm run check-visuals -- <id>     # provenance, spoilers, runs under 12 schedules
   npm run test-visuals              # the engine's own tests
   npx tsc --noEmit
   npm run viz -- shots <id>         # screenshots at 300 and 640 px, light and dark
   ```

   Then `make lint` from the repository root. Open the screenshots and apply
   the review test below.

10. **Review against HEAD.** Read your program next to the committed code,
    line by line. Most real mistakes pass every check: an invented
    goroutine, a classic bug drawn as the goal (`wg.Add` after `go`), two
    runs blended into one, a test marked before it can reach its verdict.

## The review test

Look at the last frame of each scene with the captions hidden.

- Can you name the bug (Today) or the fix (Goal, inside) from the picture
  alone?
- Does every node exist in the code it models, with the code's name?
- Do Today and Goal differ by exactly the lesson?

## Never

| Never | Why |
| --- | --- |
| Edit `web/src/viz/engine/*`, `view/*`, `styles.css`, or the door to make a spec work | The visual language must stay one language. Report the missing piece. |
| Write a number that is not a constant or derived from one | Numbers drift from the code. |
| Show code in a goal scene, or a solution-only word in a Problem scene | It spoils the exercise. `check-visuals` refuses both. |
| Invent a goroutine, a channel, or an order Go does not promise | The scheduler picks orders with a seed; let it. |
| Edit `main.go`, `check_test.go`, or a mock | The owner keeps solutions there. |
| Change a README diagram without `npm run viz -- pin <id>` | The clone and the site drift. `make lint` refuses it. |
| Commit the spec without its README | The scoped commit gate refuses a spec whose README has unstaged changes. |
