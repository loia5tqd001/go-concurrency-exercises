// The data contract for a schema-3 visualisation.
//
// A spec describes a small Go program: the goroutines, the objects they
// share, and each goroutine's program as a generator of Go operations. The
// scheduler in sim.ts runs those programs. It decides every order and every
// time, so a frame cannot show a state that Go would not produce. The graph
// view draws what the run did; a spec has no colour, glyph, or pixel field.

export type Value = string | number | boolean | null;

// A value that travels between nodes. It keeps its identity when a goroutine
// forwards it, so the eye can follow one item through a pipeline.
export interface Token {
  readonly id: number;
  readonly v: Value;
  // Index into the token palette (0, 1, or 2): the creating goroutine's `tone`,
  // which defaults to 0.
  readonly tone: number;
}

export type Tier = "today" | "goal" | "inside";

// What the end of a run looks like. The scheduler derives it; a scene
// declares the one it expects, and viz-check compares them.
//   ok        every started goroutine returned
//   leak      main returned while some goroutine is still blocked
//   deadlock  main is blocked and nothing can wake anything
//   panic     a goroutine panicked (a send on a closed channel, ...)
//   exit      the process ended through exit() (os.Exit, a fatal signal)
//   timeout   the run reached the scene's `until`, or only endless work is left
export type Outcome = "ok" | "leak" | "deadlock" | "panic" | "exit" | "timeout";

export type Params = Readonly<Record<string, Value>>;

// ---------------------------------------------------------------------------
// Programs and operations
// ---------------------------------------------------------------------------

// The goroutine a program runs as. `i` is the member index in a group (0 for
// a single goroutine); `P` holds the scene's knob values.
export interface Self {
  readonly id: string;
  readonly key: string;
  readonly i: number;
  readonly P: Params;
  // Plain variables every goroutine of one run shares, for what a test keeps
  // on the side (consumedSoFar, maxGap). The graph never draws them; a fact
  // node draws what the learner should see. Each run starts with {}.
  readonly vars: Record<string, number>;
}

export interface RecvResult {
  readonly ok: boolean;
  readonly v: Value;
  readonly tok: Token | undefined;
}

export interface SelectResult extends RecvResult {
  // The index of the case that ran, or -1 for `default`.
  readonly i: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Program = (self: Self) => Generator<Op, void, any>;

export interface OpBase {
  // A unique piece of the Go line this operation models. The code panel marks
  // that line while the goroutine sits on it. Without `at`, the kit looks for
  // the operation's usual Go text in the lines the goroutine owns.
  at?: string;
}

export type Sendable = Value | Token;

export type SelectCase =
  | { dir: "recv"; ch: string }
  | { dir: "send"; ch: string; v: Sendable };

export type Op = OpBase &
  (
    | { op: "work"; ms: number; label?: string }
    | { op: "sleep"; ms: number }
    | { op: "send"; ch: string; v: Sendable }
    | { op: "recv"; ch: string }
    | { op: "select"; cases: readonly SelectCase[]; default?: boolean }
    | { op: "close"; ch: string }
    | { op: "remake"; ch: string }
    | { op: "notify"; ch: string; v: Sendable }
    | { op: "go"; target: string }
    | { op: "add"; wg: string; n: number }
    | { op: "done"; wg: string }
    | { op: "wait"; wg: string }
    | { op: "lock"; mu: string }
    | { op: "unlock"; mu: string }
    | { op: "condWait"; cond: string }
    | { op: "condSignal"; cond: string }
    | { op: "condBroadcast"; cond: string }
    | { op: "start"; timer: string }
    | { op: "reset"; timer: string }
    | { op: "stop"; timer: string }
    | { op: "cancel"; ctx: string }
    | { op: "put"; slice: string; i: number; v: Sendable }
    | { op: "append"; slice: string; v: Sendable }
    | { op: "shift"; slice: string }
    | { op: "set"; fact: string; v: Value }
    | { op: "inc"; fact: string; n: number }
    | { op: "print"; v: Sendable }
    | { op: "pass"; test: string }
    | { op: "fail"; test: string }
    | { op: "panic"; text: string }
    | { op: "exit"; text: string }
  );

export type OpName = Op["op"];

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

// A grid position: column, then row. Data flows left to right, so the source
// sits in column 0. Fractions are allowed. On a narrow screen the view turns
// the grid so data flows top to bottom.
export type Pos = readonly [col: number, row: number];

interface NodeBase {
  label: string;
  pos: Pos;
}

export interface GoroutineNode extends NodeBase {
  kind: "goroutine";
  program: Program;
  // A group of identical goroutines, drawn as one box with a cell per member.
  // Members are addressed as worker[3], or all at once as worker[*].
  count?: number;
  // The number of member 0 in text. Set 1 when the README counts from 1.
  base?: number;
  // The caller. When main returns, any goroutine still blocked has leaked;
  // when main is blocked and nothing can run, the program is deadlocked.
  main?: boolean;
  // The goroutine exists only once another goroutine runs go(id).
  spawned?: boolean;
  // The colour of the values this goroutine creates: 0, 1, or 2. Give
  // producers different tones when the lesson is how their values mix.
  tone?: number;
}

export interface ChannelNode extends NodeBase {
  kind: "channel";
  // 0 is an unbuffered channel.
  cap: number;
}

export interface WaitGroupNode extends NodeBase {
  kind: "waitgroup";
}

export interface MutexNode extends NodeBase {
  kind: "mutex";
}

export interface CondNode extends NodeBase {
  kind: "cond";
  // The mutex Locker passed to sync.NewCond.
  mu: string;
}

export interface SliceNode extends NodeBase {
  kind: "slice";
  size: number;
}

export interface TimerNode extends NodeBase {
  kind: "timer";
  // Milliseconds from start or reset to the tick.
  after: number;
}

export interface ContextNode extends NodeBase {
  kind: "context";
  // Milliseconds from the start of the run to the deadline.
  deadline?: number;
}

// A plain fact a test measures: a counter, a gap, a state machine.
export interface FactNode extends NodeBase {
  kind: "fact";
  value: Value;
  // A number past `limit` draws in the fail colour.
  limit?: number;
  unit?: string;
  // A state machine: the fact's value is one of these, drawn as pills.
  states?: readonly string[];
}

export type NodeDef =
  | GoroutineNode
  | ChannelNode
  | WaitGroupNode
  | MutexNode
  | CondNode
  | SliceNode
  | TimerNode
  | ContextNode
  | FactNode;

export type NodeKind = NodeDef["kind"];

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

export interface Knob {
  key: string;
  label: string;
  options: readonly Value[];
  value: Value;
}

export interface TestDef {
  // The full Go test name, as `go test` prints it.
  name: string;
  // A short name for the chip, at most 16 characters.
  short: string;
  // Judged on the finished run, unless a program marks the test first with
  // pass() or fail().
  judge?: (run: RunSummary) => boolean;
}

// A pause with a caption. The player stops at the first event that matches,
// after the previous stop, and shows `say`.
export interface Stop {
  when: Match;
  say: string;
}

// An event filter. Every field that is present must match.
export interface Match {
  op?: OpName | "return" | "block" | "fire" | "end";
  // The goroutine node id, or a member such as worker[3].
  g?: string;
  // The channel, wait group, mutex, cond, timer, context, slice, or fact.
  node?: string;
  // The nth match, counting from 1.
  nth?: number;
  // At or after this time.
  t?: number;
}

export interface CodeDef {
  // Where the excerpt comes from: a file of the exercise ("main.go") or
  // "solution" for the solution doc. viz-check proves every line is verbatim.
  file: string;
  // The excerpt. A line may start with "@id,id " to say which goroutine
  // nodes own it; the tags are not shown. A line "…" marks a gap.
  text: string;
}

export interface Clock {
  unit: "ms";
  // A time limit the run is judged against, such as a test's budget.
  budget?: { at: number; label: string };
  // Real milliseconds per simulated millisecond at 1× speed. Scenes that
  // share a door should share it, so their durations compare honestly.
  slow?: number;
}

export interface Model {
  nodes: Readonly<Record<string, NodeDef>>;
  // Edge routes that should bend around the graph instead of crossing it,
  // keyed "from>to".
  routes?: Readonly<Record<string, "below" | "above">>;
  // One or two sentences under the graph: what to watch, and why.
  insight: string;
  stops?: readonly Stop[];
  tests?: Readonly<Record<string, TestDef>>;
  code?: CodeDef;
  clock?: Clock;
  // Stop the run here, the way a test's timeout would.
  until?: number;
  expect: Expect;
}

export interface Expect {
  outcome: Outcome;
  tests?: Readonly<Record<string, "pass" | "fail">>;
  // The end time of the run, when it is part of the lesson.
  t?: number;
}

export interface SceneDef {
  id: string;
  // At most 8 characters: Today, Goal, Leak, Fixed.
  chip: string;
  tier: Tier;
  // One sentence for screen readers and the figure's label.
  summary: string;
  knobs?: readonly Knob[];
  model: Model | ((P: Params) => Model);
}

// A number with its proof: `text` occurs in `file` and contains `value`.
export interface Constant {
  value: number | string;
  file: string;
  text: string;
}

export interface Anchor {
  file: string;
  text: string;
}

export interface Diagrams {
  today: string;
  goal?: string;
}

export interface VizSpec {
  schema: 3;
  exercise: string;
  diagrams: Diagrams;
  constants?: Readonly<Record<string, Constant>>;
  anchors?: readonly Anchor[];
  // Words a Problem scene may use although the solution declares them:
  // word -> why it is safe.
  spoilerOk?: Readonly<Record<string, string>>;
  scenes: readonly SceneDef[];
}

// ---------------------------------------------------------------------------
// Run results (written by sim.ts, read by the view, the tests, and judges)
// ---------------------------------------------------------------------------

export type GStatus = "idle" | "running" | "working" | "blocked" | "done" | "panicked" | "leaked" | "deadlocked";

export interface GView {
  status: GStatus;
  // What the goroutine waits on, in Go syntax: "out <-", "<-c2", "select",
  // "wg.Wait()", "mu.Lock()", "time.Sleep".
  why?: string;
  // The work label while working.
  label?: string;
  workStart?: number;
  workEnd?: number;
  // The code line (0-based, in the excerpt) the goroutine sits on.
  line?: number;
  panic?: string;
}

// Where a token is: on a goroutine (held), in a channel slot, a slice cell,
// a timer, a mutex (its key), the output strip, or gone.
export interface Loc {
  node: string;
  slot?: number;
}

export interface TokenView {
  v: Value;
  tone: number;
  at: Loc;
  // A mutex's key and a timer's tick draw as glyphs, not values.
  glyph?: "key" | "tick";
}

export interface ChannelView {
  cap: number;
  closed: boolean;
  buf: number[];
  senders: number;
  receivers: number;
}

export interface TimerView {
  state: "idle" | "running" | "fired" | "stopped";
  fireAt?: number;
  pending?: number;
}

export interface World {
  t: number;
  g: Record<string, GView>;
  tokens: Record<number, TokenView>;
  ch: Record<string, ChannelView>;
  wg: Record<string, { n: number; waiters: number }>;
  mu: Record<string, { holder?: string; waiters: number; key: number }>;
  cond: Record<string, { waiters: number }>;
  timer: Record<string, TimerView>;
  ctx: Record<string, { done: boolean; cause?: "deadline" | "cancel"; waiters: number }>;
  slice: Record<string, (number | null)[]>;
  fact: Record<string, Value>;
  tests: Record<string, "pass" | "fail">;
  printed: number[];
}

export interface Move {
  tok: number;
  from: Loc;
  to: Loc;
  // A channel the token passes through without stopping (a hand-off).
  via?: string;
  // The token is created at `from` in this move.
  born?: boolean;
}

export interface Event {
  t: number;
  // The goroutine key, or "" for the runtime (a timer, a deadline).
  g: string;
  op: OpName | "return" | "block" | "fire" | "end";
  node?: string;
  v?: Value;
  // The operation could not complete, so the goroutine is now blocked.
  parked?: boolean;
  // One sentence that says what happened, for the transcript.
  text: string;
}

export interface MicroStep {
  event: Event;
  moves: Move[];
  // Goroutine keys whose drawn state changed.
  changed: string[];
  world: World;
}

export type EdgeType = "data" | "close" | "sync" | "spawn" | "cancel";

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  // The Go call the edge stands for, when the line alone does not say:
  // "Done()", "Wait()", "Lock()".
  label?: string;
}

export interface RunSummary {
  outcome: Outcome;
  t: number;
  world: World;
  // The run's shared variables at the end.
  vars: Readonly<Record<string, number>>;
  // The most goroutines of a node that worked at one time.
  peak: Record<string, number>;
  events: readonly Event[];
}

export interface Run extends RunSummary {
  initial: World;
  steps: MicroStep[];
  edges: Edge[];
  // The outcome sentence: "Leak: gen is blocked on out <- with nobody left
  // to receive." It is empty for a plain ok.
  verdict: string;
  // Mistakes in the spec: an unknown node, a wait group below zero that the
  // scene did not expect, a loop with no end. viz-check fails on any.
  errors: string[];
  // Stops resolved to step indexes, in order. -1 when a stop never matched.
  stopAt: number[];
  // Code lines owned by each goroutine node, from the excerpt's @tags.
  owners: Record<string, number[]>;
}
