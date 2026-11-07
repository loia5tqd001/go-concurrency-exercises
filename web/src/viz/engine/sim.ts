// The scheduler. It runs every goroutine's program under Go's rules and
// records each operation as a step with a full snapshot of the world.
//
// Time is virtual and in milliseconds. Channel operations take no time;
// only work(), sleep(), timers, and deadlines move the clock. When several
// goroutines wake at one instant, or a select has several ready cases, or a
// mutex has several waiters, a seeded random choice picks one, as Go's own
// scheduler would pick some order. The same seed gives the same run.

import type {
  ChannelNode,
  CodeDef,
  ContextNode,
  Edge,
  EdgeType,
  Event,
  GoroutineNode,
  GStatus,
  GView,
  Loc,
  MicroStep,
  Model,
  Move,
  Op,
  OpName,
  Outcome,
  Params,
  RecvResult,
  Run,
  RunSummary,
  SceneDef,
  SelectCase,
  SelectResult,
  Self,
  Sendable,
  Token,
  TokenView,
  Value,
  VizSpec,
  World,
} from "./model.ts";

// A run that reaches this many steps has a loop with no exit.
const MAX_STEPS = 4000;

// ---------------------------------------------------------------------------
// Scenes, knobs, and members
// ---------------------------------------------------------------------------

export function defaultParams(scene: SceneDef): Params {
  const P: Record<string, Value> = {};
  for (const knob of scene.knobs ?? []) P[knob.key] = knob.value;
  return P;
}

// Every combination of knob values, for the checks.
export function knobCombos(scene: SceneDef): Params[] {
  let combos: Record<string, Value>[] = [{}];
  for (const knob of scene.knobs ?? []) {
    const next: Record<string, Value>[] = [];
    for (const combo of combos) for (const option of knob.options) next.push({ ...combo, [knob.key]: option });
    combos = next;
  }
  return combos;
}

export function resolveModel(scene: SceneDef, P: Params): Model {
  return typeof scene.model === "function" ? scene.model(P) : scene.model;
}

export function memberKeys(id: string, def: GoroutineNode): string[] {
  if (def.count === undefined) return [id];
  return Array.from({ length: def.count }, (_, i) => `${id}[${i}]`);
}

// The goroutine node a member key belongs to: worker[3] -> worker.
export function nodeOf(key: string): string {
  const at = key.indexOf("[");
  return at < 0 ? key : key.slice(0, at);
}

export function memberIndex(key: string): number {
  const match = /\[(\d+)\]$/.exec(key);
  return match ? Number(match[1]) : 0;
}

// How text names a goroutine: "caller", or "worker-3" for a member.
export function goName(model: Model, key: string): string {
  const def = model.nodes[nodeOf(key)];
  if (def === undefined) return key;
  if (def.kind !== "goroutine" || def.count === undefined) return def.label;
  return `${def.label}-${memberIndex(key) + (def.base ?? 0)}`;
}

export function valueText(v: Value | undefined): string {
  if (v === undefined || v === null) return "nil";
  if (typeof v === "string") return v === "" ? '""' : v;
  return String(v);
}

// ---------------------------------------------------------------------------
// Code excerpts
// ---------------------------------------------------------------------------

export interface CodeLine {
  text: string;
  owners: string[];
  gap: boolean;
}

const TAG = /^@([\w,*[\]-]+) ?/;

export function parseCode(code: CodeDef | undefined): CodeLine[] {
  if (code === undefined) return [];
  const lines = code.text.replace(/^\n+/, "").replace(/\s+$/, "").split("\n");
  return lines.map((raw) => {
    const match = TAG.exec(raw);
    const owners = match ? match[1]!.split(",").filter((owner) => owner !== "") : [];
    const text = match ? raw.slice(match[0].length) : raw;
    return { text, owners, gap: text.trim() === "…" };
  });
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

interface Shared {
  g: string;
  fired: boolean;
}

interface Waiter {
  w: Shared;
  // The select case index; 0 for a plain send or receive.
  i: number;
  // A send's value. A plain send has its token already; a select's send
  // case creates the token only when the case runs.
  v?: Sendable;
  tok?: Token;
  // Set on select waiters, so the result carries the case index.
  select?: boolean;
}

interface GRT {
  key: string;
  id: string;
  def: GoroutineNode;
  status: GStatus;
  why?: string;
  label?: string;
  workStart?: number;
  workEnd?: number;
  wake?: number;
  // The mutex a goroutine waits to lock, for naming a deadlock's cycle.
  waitMu?: string;
  line?: number;
  panic?: string;
  started: boolean;
  gen?: Generator<Op, void, unknown>;
}

interface CHRT {
  id: string;
  label: string;
  cap: number;
  buf: Token[];
  closed: boolean;
  sendq: Waiter[];
  recvq: Waiter[];
}

interface TimerRT {
  id: string;
  label: string;
  after: number;
  state: "idle" | "running" | "fired" | "stopped";
  fireAt?: number;
  pending?: Token;
  recvq: Waiter[];
}

interface CtxRT {
  id: string;
  label: string;
  deadline?: number;
  done: boolean;
  cause?: "deadline" | "cancel";
  recvq: Waiter[];
}

interface MuRT {
  id: string;
  label: string;
  holder?: string;
  waiters: string[];
  key: Token;
}

interface WgRT {
  id: string;
  label: string;
  n: number;
  waiters: string[];
}

class Halt extends Error {}

class Sim {
  readonly model: Model;
  readonly P: Params;
  t = 0;
  seed: number;
  goroutines = new Map<string, GRT>();
  channels = new Map<string, CHRT>();
  timers = new Map<string, TimerRT>();
  contexts = new Map<string, CtxRT>();
  mutexes = new Map<string, MuRT>();
  wgs = new Map<string, WgRT>();
  slices = new Map<string, (Token | null)[]>();
  facts = new Map<string, Value>();
  tests = new Map<string, "pass" | "fail">();
  printed: Token[] = [];
  locs = new Map<number, Loc>();
  glyphs = new Map<number, "key" | "tick">();
  tokens = new Map<number, Token>();
  nextToken = 0;
  ready: { key: string; value: unknown }[] = [];
  steps: MicroStep[] = [];
  edges = new Map<string, Edge>();
  errors: string[] = [];
  peak: Record<string, number> = {};
  halted: "panic" | "exit" | undefined;
  haltText = "";
  last: World;
  code: CodeLine[];
  owners: Record<string, number[]> = {};
  // Each step's pending moves and event. emit() flushes them.
  moves: Move[] = [];
  vars: Record<string, number> = {};
  missingAt = new Set<string>();

  constructor(model: Model, P: Params, seed: number) {
    this.model = model;
    this.P = P;
    this.seed = seed > 0 ? seed : 1;
    this.code = parseCode(model.code);
    this.code.forEach((line, n) => {
      for (const owner of line.owners) (this.owners[owner] ??= []).push(n);
    });

    for (const [id, def] of Object.entries(model.nodes)) {
      switch (def.kind) {
        case "goroutine":
          for (const key of memberKeys(id, def)) {
            this.goroutines.set(key, { key, id, def, status: "idle", started: false });
          }
          break;
        case "channel":
          this.channels.set(id, { id, label: def.label, cap: def.cap, buf: [], closed: false, sendq: [], recvq: [] });
          break;
        case "timer":
          this.timers.set(id, { id, label: def.label, after: def.after, state: "idle", recvq: [] });
          break;
        case "context":
          this.contexts.set(id, { id, label: def.label, deadline: def.deadline, done: false, recvq: [] });
          break;
        case "mutex": {
          const key = this.newToken("", 2);
          this.locs.set(key.id, { node: id });
          this.glyphs.set(key.id, "key");
          this.mutexes.set(id, { id, label: def.label, waiters: [], key });
          break;
        }
        case "waitgroup":
          this.wgs.set(id, { id, label: def.label, n: 0, waiters: [] });
          break;
        case "slice":
          this.slices.set(id, Array.from({ length: def.size }, () => null));
          break;
        case "fact":
          this.facts.set(id, def.value);
          break;
      }
    }
    this.last = this.snapshot();
  }

  // ---- randomness --------------------------------------------------------

  rand(): number {
    // mulberry32
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let x = this.seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)]!;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  // ---- names and errors --------------------------------------------------

  name(key: string): string {
    return goName(this.model, key);
  }

  label(id: string): string {
    return this.model.nodes[id]?.label ?? id;
  }

  fatal(message: string): never {
    this.errors.push(message);
    this.halted = "panic";
    this.haltText = message;
    throw new Halt(message);
  }

  edge(from: string, to: string, type: EdgeType, label?: string): void {
    const key = `${from}>${to}>${type}`;
    const old = this.edges.get(key);
    if (old === undefined) this.edges.set(key, label === undefined ? { from, to, type } : { from, to, type, label });
    // A later call names an edge an earlier one left plain (start, then Reset).
    else if (old.label === undefined && label !== undefined) old.label = label;
  }

  // ---- tokens --------------------------------------------------------------

  newToken(v: Value, tone: number): Token {
    const tok: Token = Object.freeze({ id: ++this.nextToken, v, tone });
    this.tokens.set(tok.id, tok);
    return tok;
  }

  isToken(v: Sendable): v is Token {
    return typeof v === "object" && v !== null && "id" in v && "tone" in v;
  }

  // The token a goroutine sends: the one it holds, or a new one for a raw value.
  tokenFor(g: GRT, v: Sendable): Token {
    if (this.isToken(v)) {
      const loc = this.locs.get(v.id);
      if (loc === undefined || loc.node !== g.key) {
        this.fatal(`${this.name(g.key)} sends ${valueText(v.v)}, but it does not hold that value`);
      }
      return v;
    }
    const tok = this.newToken(v, g.def.tone ?? 0);
    this.locs.set(tok.id, { node: g.key });
    this.moves.push({ tok: tok.id, from: { node: g.key }, to: { node: g.key }, born: true });
    return tok;
  }

  move(tok: Token, to: Loc, via?: string): void {
    const from = this.locs.get(tok.id) ?? { node: "gone" };
    // A token born in this step flies from where it was born.
    const born = this.moves.findIndex((m) => m.tok === tok.id && m.born === true && m.from.node === m.to.node);
    if (born >= 0) this.moves.splice(born, 1);
    this.moves.push({ tok: tok.id, from, to, via, born: born >= 0 ? true : undefined });
    if (to.node === "gone") this.locs.delete(tok.id);
    else this.locs.set(tok.id, to);
  }

  // A goroutine that receives a new value is done with the one it held. A
  // mutex key stays: the goroutine still holds the lock.
  dropHeld(key: string): void {
    for (const [id, loc] of [...this.locs]) {
      if (loc.node === key && this.glyphs.get(id) !== "key") this.move(this.tokens.get(id)!, { node: "gone" });
    }
  }

  // ---- steps ---------------------------------------------------------------

  emit(g: string, op: Event["op"], text: string, extra: Partial<Event> = {}): void {
    const world = this.snapshot();
    const changed: string[] = [];
    for (const [key, view] of Object.entries(world.g)) {
      const before = this.last.g[key];
      if (before === undefined || drawn(before) !== drawn(view)) changed.push(key);
    }
    const event: Event = { t: this.t, g, op, text, ...extra };
    this.steps.push({ event, moves: this.moves, changed, world });
    this.moves = [];
    this.last = world;
    this.trackPeak(world);
    if (this.steps.length > MAX_STEPS) {
      this.errors.push(`the run passed ${MAX_STEPS} steps; does a loop never end?`);
      this.halted = "panic";
      this.haltText = "too many steps";
      throw new Halt("too many steps");
    }
  }

  trackPeak(world: World): void {
    const working: Record<string, number> = {};
    for (const [key, view] of Object.entries(world.g)) {
      if (view.status === "working") working[nodeOf(key)] = (working[nodeOf(key)] ?? 0) + 1;
    }
    for (const [id, n] of Object.entries(working)) this.peak[id] = Math.max(this.peak[id] ?? 0, n);
  }

  snapshot(): World {
    const g: Record<string, GView> = {};
    for (const [key, rt] of this.goroutines) {
      const view: GView = { status: rt.status };
      if (rt.why !== undefined) view.why = rt.why;
      if (rt.status === "working") {
        if (rt.label !== undefined) view.label = rt.label;
        view.workStart = rt.workStart;
        view.workEnd = rt.workEnd;
      }
      if (rt.line !== undefined) view.line = rt.line;
      if (rt.panic !== undefined) view.panic = rt.panic;
      g[key] = view;
    }
    const tokens: Record<number, TokenView> = {};
    for (const [id, at] of this.locs) {
      const tok = this.tokens.get(id)!;
      const view: TokenView = { v: tok.v, tone: tok.tone, at };
      const glyph = this.glyphs.get(id);
      if (glyph !== undefined) view.glyph = glyph;
      tokens[id] = view;
    }
    const ch: World["ch"] = {};
    for (const [id, c] of this.channels) {
      ch[id] = {
        cap: c.cap,
        closed: c.closed,
        buf: c.buf.map((tok) => tok.id),
        senders: live(c.sendq),
        receivers: live(c.recvq),
      };
    }
    const wg: World["wg"] = {};
    for (const [id, w] of this.wgs) wg[id] = { n: w.n, waiters: w.waiters.length };
    const mu: World["mu"] = {};
    for (const [id, m] of this.mutexes) mu[id] = { holder: m.holder, waiters: m.waiters.length, key: m.key.id };
    const timer: World["timer"] = {};
    for (const [id, tm] of this.timers) {
      timer[id] = { state: tm.state, fireAt: tm.fireAt, pending: tm.pending?.id };
    }
    const ctx: World["ctx"] = {};
    for (const [id, c] of this.contexts) ctx[id] = { done: c.done, cause: c.cause, waiters: live(c.recvq) };
    const slice: World["slice"] = {};
    for (const [id, cells] of this.slices) slice[id] = cells.map((tok) => tok?.id ?? null);
    return {
      t: this.t,
      g,
      tokens,
      ch,
      wg,
      mu,
      timer,
      ctx,
      slice,
      fact: Object.fromEntries(this.facts),
      tests: Object.fromEntries(this.tests),
      printed: this.printed.map((tok) => tok.id),
    };
  }

  // ---- the code line a goroutine sits on ---------------------------------

  lineFor(g: GRT, op: Op): number | undefined {
    if (this.code.length === 0) return undefined;
    const owned = this.owners[g.id] ?? [];
    const order = (candidates: number[]): number | undefined => {
      if (candidates.length === 0) return undefined;
      const after = candidates.find((n) => g.line === undefined || n >= g.line);
      return after ?? candidates[0];
    };
    const find = (needle: string, scope: number[] | undefined): number | undefined => {
      const pool = scope ?? this.code.map((_, n) => n);
      return order(pool.filter((n) => this.code[n]!.text.includes(needle)));
    };
    if (op.at !== undefined) {
      const line = find(op.at, owned.length > 0 ? owned : undefined) ?? find(op.at, undefined);
      if (line === undefined && !this.missingAt.has(op.at)) {
        this.missingAt.add(op.at);
        this.errors.push(`${this.name(g.key)}: at "${op.at}" is in no line of the code excerpt`);
      }
      return line;
    }
    const needles = autoNeedles(op, (id) => this.label(id));
    for (const needle of needles) {
      const line = find(needle, owned.length > 0 ? owned : undefined);
      if (line !== undefined) return line;
    }
    return undefined;
  }

  // ---- the scheduler -----------------------------------------------------

  startGoroutine(g: GRT): void {
    g.started = true;
    g.status = "running";
    const self: Self = { id: g.id, key: g.key, i: memberIndex(g.key), P: this.P, vars: this.vars };
    g.gen = g.def.program(self) as Generator<Op, void, unknown>;
    this.ready.push({ key: g.key, value: undefined });
  }

  run(): void {
    try {
      // Go promises no start order, so the seed picks one.
      for (const g of this.shuffle([...this.goroutines.values()].filter((g) => g.def.spawned !== true))) this.startGoroutine(g);
      for (;;) {
        this.flush();
        if (this.halted !== undefined) return;
        const next = this.nextTime();
        const until = this.model.until;
        if (next === undefined) {
          if (until !== undefined && this.hasEndlessWork()) this.t = until;
          return;
        }
        if (until !== undefined && next > until) {
          this.t = until;
          return;
        }
        this.t = next;
        this.fireDue();
      }
    } catch (error) {
      if (!(error instanceof Halt)) throw error;
    }
  }

  hasEndlessWork(): boolean {
    return [...this.goroutines.values()].some((g) => g.status === "working" && g.workEnd === Infinity);
  }

  nextTime(): number | undefined {
    // When every goroutine has returned the program is over: a deadline or a
    // timer nobody waits on cannot happen after the process ends.
    const anyLive = [...this.goroutines.values()].some((g) => g.started && g.status !== "done" && g.status !== "panicked");
    if (!anyLive) return undefined;
    let next = Infinity;
    for (const g of this.goroutines.values()) {
      if (g.status === "working" && g.workEnd !== undefined) next = Math.min(next, g.workEnd);
      if (g.status === "blocked" && g.wake !== undefined) next = Math.min(next, g.wake);
    }
    for (const tm of this.timers.values()) if (tm.state === "running" && tm.fireAt !== undefined) next = Math.min(next, tm.fireAt);
    for (const c of this.contexts.values()) if (!c.done && c.deadline !== undefined) next = Math.min(next, c.deadline);
    return next === Infinity ? undefined : next;
  }

  fireDue(): void {
    for (const c of this.contexts.values()) {
      if (!c.done && c.deadline !== undefined && c.deadline <= this.t) {
        this.finishContext(c, "deadline");
        this.emit("", "fire", `The deadline passes: ${c.label}.Done() closes.`, { node: c.id });
      }
    }
    for (const tm of this.timers.values()) {
      if (tm.state === "running" && tm.fireAt !== undefined && tm.fireAt <= this.t) this.fireTimer(tm);
    }
    const due = [...this.goroutines.values()].filter(
      (g) =>
        (g.status === "working" && g.workEnd !== undefined && g.workEnd <= this.t) ||
        (g.status === "blocked" && g.wake !== undefined && g.wake <= this.t),
    );
    for (const g of this.shuffle(due)) {
      g.wake = undefined;
      g.status = "running";
      this.ready.push({ key: g.key, value: undefined });
    }
  }

  flush(): void {
    while (this.ready.length > 0 && this.halted === undefined) {
      const { key, value } = this.ready.shift()!;
      this.resume(this.goroutines.get(key)!, value);
    }
  }

  resume(g: GRT, value: unknown): void {
    if (g.status === "done" || g.status === "panicked") return;
    g.status = "running";
    g.why = undefined;
    let input = value;
    for (;;) {
      let result: IteratorResult<Op, void>;
      try {
        result = g.gen!.next(input);
      } catch (error) {
        if (error instanceof Halt) throw error;
        this.fatal(`${this.name(g.key)}'s program threw: ${String(error)}`);
      }
      if (result.done === true) {
        this.finish(g);
        return;
      }
      const op = result.value;
      const line = this.lineFor(g, op);
      if (line !== undefined) g.line = line;
      const out = this.exec(g, op);
      if (out === PARK) return;
      input = out;
    }
  }

  finish(g: GRT): void {
    g.status = "done";
    g.why = undefined;
    this.dropHeld(g.key);
    this.emit(g.key, "return", `${this.name(g.key)} returns.`);
  }

  park(g: GRT, why: string): void {
    g.status = "blocked";
    g.why = why;
  }

  wake(key: string, value: unknown): void {
    const g = this.goroutines.get(key)!;
    g.status = "running";
    g.why = undefined;
    g.waitMu = undefined;
    this.ready.push({ key, value });
  }

  // ---- operations ----------------------------------------------------------

  exec(g: GRT, op: Op): unknown {
    const who = this.name(g.key);
    switch (op.op) {
      case "work":
        g.status = "working";
        g.label = op.label;
        g.workStart = this.t;
        g.workEnd = later(this.t, op.ms);
        this.emit(g.key, "work", `${who} runs ${op.label ?? "its work"}${op.ms === Infinity ? " and never returns" : ` for ${op.ms} ms`}.`);
        return PARK;
      case "sleep":
        this.park(g, "time.Sleep");
        g.wake = later(this.t, op.ms);
        this.emit(g.key, "sleep", `${who} sleeps for ${op.ms} ms.`, { parked: true });
        return PARK;
      case "send":
        return this.send(g, op.ch, op.v, false);
      case "notify":
        return this.send(g, op.ch, op.v, true);
      case "recv":
        return this.recv(g, op.ch);
      case "select":
        return this.select(g, op.cases, op.default === true);
      case "close":
        return this.close(g, op.ch);
      case "remake":
        return this.remake(g, op.ch);
      case "go":
        return this.spawn(g, op.target);
      case "add":
        return this.wgAdd(g, op.wg, op.n, "add");
      case "done":
        return this.wgAdd(g, op.wg, -1, "done");
      case "wait":
        return this.wgWait(g, op.wg);
      case "lock":
        return this.lock(g, op.mu);
      case "unlock":
        return this.unlock(g, op.mu);
      case "start":
      case "reset":
      case "stop":
        return this.timerOp(g, op.op, op.timer);
      case "cancel":
        return this.cancel(g, op.ctx);
      case "put":
        return this.put(g, op.slice, op.i, op.v, "put");
      case "append": {
        const cells = this.slices.get(op.slice);
        if (cells === undefined) this.fatal(`${who} appends to ${op.slice}, which is not a slice node`);
        let last = -1;
        cells.forEach((cell, i) => {
          if (cell !== null) last = i;
        });
        if (last + 1 >= cells.length) this.fatal(`${who} appends past the end of ${op.slice}; raise its size`);
        return this.put(g, op.slice, last + 1, op.v, "append");
      }
      case "set":
      case "inc": {
        if (!this.facts.has(op.fact)) this.fatal(`${who} sets ${op.fact}, which is not a fact node`);
        this.edge(g.id, op.fact, "sync");
        const before = this.facts.get(op.fact)!;
        const value = op.op === "set" ? op.v : Number(before) + op.n;
        this.facts.set(op.fact, value);
        this.emit(g.key, op.op, `${this.label(op.fact)} becomes ${valueText(value)}.`, { node: op.fact, v: value });
        return undefined;
      }
      case "print": {
        const tok = this.tokenFor(g, op.v);
        this.move(tok, { node: "stdout", slot: this.printed.length });
        this.printed.push(tok);
        this.emit(g.key, "print", `${who} prints ${valueText(tok.v)}.`, { v: tok.v });
        return undefined;
      }
      case "pass":
      case "fail": {
        const test = this.model.tests?.[op.test];
        if (test === undefined) this.fatal(`${who} marks test ${op.test}, which the scene does not declare`);
        this.tests.set(op.test, op.op);
        this.emit(g.key, op.op, `${test.short}: ${op.op === "pass" ? "passes" : "fails"}.`, { node: op.test });
        return undefined;
      }
      case "panic":
        this.panicG(g, op.text);
        return PARK;
      case "exit":
        this.exitAll(g, op.text);
        return PARK;
      default:
        // A forgotten `yield*` on range(), or a misspelt operation, reaches
        // here as a value that is not an operation.
        return this.fatal(
          `${who} yielded ${JSON.stringify((op as { op?: unknown }).op ?? op)}, which is not an operation; use yield* for range()`,
        );
    }
  }

  send(g: GRT, id: string, v: Sendable, notify: boolean): unknown {
    const who = this.name(g.key);
    const c = this.channels.get(id);
    if (c === undefined) this.fatal(`${who} sends on ${id}, which is not a channel node`);
    const tok = this.tokenFor(g, v);
    this.edge(g.id, id, "data");
    if (c.closed) {
      this.panicG(g, `send on closed channel ${c.label}`);
      return PARK;
    }
    const r = pop(c.recvq);
    if (r !== undefined) {
      this.handOff(tok, g.key, r, c);
      this.emit(g.key, notify ? "notify" : "send", `${who} hands ${valueText(tok.v)} to ${this.name(r.w.g)} through ${c.label}.`, {
        node: id,
        v: tok.v,
      });
      return undefined;
    }
    if (c.buf.length < c.cap) {
      c.buf.push(tok);
      this.move(tok, { node: id, slot: c.buf.length - 1 });
      this.emit(g.key, notify ? "notify" : "send", `${who} puts ${valueText(tok.v)} into ${c.label}.`, { node: id, v: tok.v });
      return undefined;
    }
    if (notify) {
      this.move(tok, { node: "gone" });
      this.emit(g.key, "notify", `${c.label} is full, so ${valueText(tok.v)} is dropped.`, { node: id, v: tok.v });
      return undefined;
    }
    this.park(g, `${c.label} <-`);
    c.sendq.push({ w: { g: g.key, fired: false }, i: 0, tok });
    this.emit(g.key, "send", `${who} waits to send ${valueText(tok.v)} on ${c.label}: nobody is receiving.`, {
      node: id,
      v: tok.v,
      parked: true,
    });
    return PARK;
  }

  // A value goes straight from a sender to a waiting receiver.
  handOff(tok: Token, from: string, r: Waiter, c: CHRT): void {
    r.w.fired = true;
    this.dropHeld(r.w.g);
    this.move(tok, { node: r.w.g }, c.id);
    this.edge(c.id, nodeOf(r.w.g), "data");
    this.wake(r.w.g, result(r, true, tok));
    void from;
  }

  recv(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const c = this.channels.get(id);
    if (c !== undefined) {
      this.edge(id, g.id, "data");
      const got = this.takeFrom(g, c, 0, false);
      if (got !== undefined) return got;
      this.park(g, `<-${c.label}`);
      c.recvq.push({ w: { g: g.key, fired: false }, i: 0 });
      this.emit(g.key, "recv", `${who} waits to receive from ${c.label}: it is empty.`, { node: id, parked: true });
      return PARK;
    }
    const tm = this.timers.get(id);
    if (tm !== undefined) {
      this.edge(id, g.id, "data");
      if (tm.pending !== undefined) return this.takeTick(g, tm, 0, false);
      this.park(g, `<-${tm.label}.C`);
      tm.recvq.push({ w: { g: g.key, fired: false }, i: 0 });
      this.emit(g.key, "recv", `${who} waits for ${tm.label} to fire.`, { node: id, parked: true });
      return PARK;
    }
    const ctx = this.contexts.get(id);
    if (ctx !== undefined) {
      this.edge(id, g.id, "sync", "Done()");
      if (ctx.done) {
        this.emit(g.key, "recv", `${ctx.label}.Done() is closed, so ${who} goes on.`, { node: id });
        return { ok: false, v: null, tok: undefined } satisfies RecvResult;
      }
      this.park(g, `<-${ctx.label}.Done()`);
      ctx.recvq.push({ w: { g: g.key, fired: false }, i: 0 });
      this.emit(g.key, "recv", `${who} waits for ${ctx.label} to be done.`, { node: id, parked: true });
      return PARK;
    }
    this.fatal(`${who} receives from ${id}, which is not a channel, timer, or context node`);
  }

  // A receive that can complete now. It returns undefined when it cannot.
  takeFrom(g: GRT, c: CHRT, i: number, isSelect: boolean): RecvResult | SelectResult | undefined {
    const who = this.name(g.key);
    if (c.buf.length > 0) {
      const tok = c.buf.shift()!;
      this.dropHeld(g.key);
      this.move(tok, { node: g.key });
      // The rest slide one slot toward the exit: the oldest leaves next.
      c.buf.forEach((rest, slot) => this.move(rest, { node: c.id, slot }));
      const s = pop(c.sendq);
      if (s !== undefined) {
        const sent = s.tok ?? this.tokenFor(this.goroutines.get(s.w.g)!, s.v!);
        s.w.fired = true;
        c.buf.push(sent);
        this.move(sent, { node: c.id, slot: c.buf.length - 1 });
        this.wake(s.w.g, s.select === true ? ({ i: s.i, ok: true, v: sent.v, tok: sent } satisfies SelectResult) : undefined);
      }
      this.emit(g.key, "recv", `${who} takes ${valueText(tok.v)} from ${c.label}.`, { node: c.id, v: tok.v });
      return withCase({ ok: true, v: tok.v, tok }, i, isSelect);
    }
    const s = pop(c.sendq);
    if (s !== undefined) {
      const sender = this.goroutines.get(s.w.g)!;
      const tok = s.tok ?? this.tokenFor(sender, s.v!);
      s.w.fired = true;
      this.dropHeld(g.key);
      this.move(tok, { node: g.key }, c.id);
      this.edge(sender.id, c.id, "data");
      this.wake(s.w.g, s.select === true ? ({ i: s.i, ok: true, v: tok.v, tok } satisfies SelectResult) : undefined);
      this.emit(g.key, "recv", `${who} takes ${valueText(tok.v)} straight from ${this.name(s.w.g)} through ${c.label}.`, {
        node: c.id,
        v: tok.v,
      });
      return withCase({ ok: true, v: tok.v, tok }, i, isSelect);
    }
    if (c.closed) {
      this.emit(g.key, "recv", `${c.label} is closed and empty, so ${who}'s receive ends.`, { node: c.id });
      return withCase({ ok: false, v: null, tok: undefined }, i, isSelect);
    }
    return undefined;
  }

  takeTick(g: GRT, tm: TimerRT, i: number, isSelect: boolean): RecvResult | SelectResult {
    const tok = tm.pending!;
    tm.pending = undefined;
    this.dropHeld(g.key);
    this.move(tok, { node: g.key });
    this.emit(g.key, "recv", `${this.name(g.key)} receives ${tm.label}'s tick.`, { node: tm.id });
    return withCase({ ok: true, v: tok.v, tok }, i, isSelect);
  }

  caseReady(c: SelectCase): boolean {
    const ch = this.channels.get(c.ch);
    if (ch !== undefined) {
      if (c.dir === "recv") return ch.buf.length > 0 || live(ch.sendq) > 0 || ch.closed;
      return ch.closed || live(ch.recvq) > 0 || ch.buf.length < ch.cap;
    }
    if (c.dir === "send") return false;
    const tm = this.timers.get(c.ch);
    if (tm !== undefined) return tm.pending !== undefined;
    const ctx = this.contexts.get(c.ch);
    if (ctx !== undefined) return ctx.done;
    return false;
  }

  select(g: GRT, cases: readonly SelectCase[], hasDefault: boolean): unknown {
    const who = this.name(g.key);
    for (const c of cases) {
      if (!this.channels.has(c.ch) && !this.timers.has(c.ch) && !this.contexts.has(c.ch)) {
        this.fatal(`${who}'s select names ${c.ch}, which is not a channel, timer, or context node`);
      }
      if (c.dir === "send") this.edge(g.id, c.ch, "data");
      else if (this.contexts.has(c.ch)) this.edge(c.ch, g.id, "sync", "Done()");
      else this.edge(c.ch, g.id, "data");
    }
    const ready = cases.map((c, i) => ({ c, i })).filter(({ c }) => this.caseReady(c));
    if (ready.length > 0) {
      const { c, i } = this.pick(ready);
      if (c.dir === "send") {
        const ch = this.channels.get(c.ch)!;
        const tok = this.tokenFor(g, c.v);
        if (ch.closed) {
          this.panicG(g, `send on closed channel ${ch.label}`);
          return PARK;
        }
        const r = pop(ch.recvq);
        if (r !== undefined) {
          this.handOff(tok, g.key, r, ch);
          this.emit(g.key, "select", `${who}'s select sends ${valueText(tok.v)} to ${this.name(r.w.g)} through ${ch.label}.`, {
            node: ch.id,
            v: tok.v,
          });
        } else {
          ch.buf.push(tok);
          this.move(tok, { node: ch.id, slot: ch.buf.length - 1 });
          this.emit(g.key, "select", `${who}'s select puts ${valueText(tok.v)} into ${ch.label}.`, { node: ch.id, v: tok.v });
        }
        return { i, ok: true, v: tok.v, tok } satisfies SelectResult;
      }
      const ch = this.channels.get(c.ch);
      if (ch !== undefined) return this.takeFrom(g, ch, i, true);
      const tm = this.timers.get(c.ch);
      if (tm !== undefined) return this.takeTick(g, tm, i, true);
      const ctx = this.contexts.get(c.ch)!;
      this.emit(g.key, "select", `${who}'s select sees ${ctx.label}.Done() closed.`, { node: ctx.id });
      return { i, ok: false, v: null, tok: undefined } satisfies SelectResult;
    }
    if (hasDefault) {
      this.emit(g.key, "select", `No case is ready, so ${who}'s select takes default.`);
      return { i: -1, ok: false, v: null, tok: undefined } satisfies SelectResult;
    }
    const shared: Shared = { g: g.key, fired: false };
    cases.forEach((c, i) => {
      const ch = this.channels.get(c.ch);
      if (ch !== undefined) {
        if (c.dir === "send") ch.sendq.push({ w: shared, i, v: c.v, select: true });
        else ch.recvq.push({ w: shared, i, select: true });
        return;
      }
      const tm = this.timers.get(c.ch);
      if (tm !== undefined) {
        tm.recvq.push({ w: shared, i, select: true });
        return;
      }
      this.contexts.get(c.ch)!.recvq.push({ w: shared, i, select: true });
    });
    this.park(g, "select");
    this.emit(g.key, "select", `${who} waits in select: no case is ready.`, { parked: true });
    return PARK;
  }

  close(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const c = this.channels.get(id);
    if (c === undefined) this.fatal(`${who} closes ${id}, which is not a channel node`);
    this.edge(g.id, id, "close");
    if (c.closed) {
      this.panicG(g, `close of closed channel ${c.label}`);
      return PARK;
    }
    c.closed = true;
    let r: Waiter | undefined;
    while ((r = pop(c.recvq)) !== undefined) {
      r.w.fired = true;
      this.wake(r.w.g, result(r, false, undefined));
    }
    const senders: string[] = [];
    let s: Waiter | undefined;
    while ((s = pop(c.sendq)) !== undefined) {
      s.w.fired = true;
      senders.push(s.w.g);
    }
    this.emit(g.key, "close", `${who} closes ${c.label}.`, { node: id });
    // A sender that was waiting on the channel panics when it closes.
    if (senders.length > 0) this.panicG(this.goroutines.get(senders[0]!)!, `send on closed channel ${c.label}`);
    return undefined;
  }

  remake(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const c = this.channels.get(id);
    if (c === undefined) this.fatal(`${who} remakes ${id}, which is not a channel node`);
    if (live(c.sendq) + live(c.recvq) > 0) {
      this.fatal(`${who} remakes ${c.label} while goroutines still wait on the old channel; give the old one its own node`);
    }
    for (const tok of c.buf) this.move(tok, { node: "gone" });
    c.buf = [];
    c.closed = false;
    c.sendq = [];
    c.recvq = [];
    this.emit(g.key, "remake", `${who} makes a fresh ${c.label}.`, { node: id });
    return undefined;
  }

  spawn(g: GRT, target: string): unknown {
    const who = this.name(g.key);
    const id = nodeOf(target);
    const def = this.model.nodes[id];
    if (def === undefined || def.kind !== "goroutine") this.fatal(`${who} runs go ${target}, which is not a goroutine node`);
    if (def.spawned !== true) this.fatal(`${who} runs go ${target}, but ${id} starts on its own; give it spawned: true`);
    let keys: string[];
    if (target.endsWith("[*]")) keys = memberKeys(id, def);
    else if (def.count !== undefined && !target.includes("[")) this.fatal(`go ${target}: name a member, ${id}[0], or all of them, ${id}[*]`);
    else keys = [target];
    for (const key of keys.length > 1 ? this.shuffle([...keys]) : keys) {
      const child = this.goroutines.get(key);
      if (child === undefined) this.fatal(`go ${key}: no such member`);
      if (child.started) this.fatal(`go ${key}: it has already started`);
      this.startGoroutine(child);
    }
    this.edge(g.id, id, "spawn");
    const named = keys.length > 1 ? `${keys.length} ${def.label} goroutines` : this.name(keys[0]!);
    this.emit(g.key, "go", `${who} starts ${named}.`, { node: id });
    return undefined;
  }

  wgAdd(g: GRT, id: string, n: number, op: "add" | "done"): unknown {
    const who = this.name(g.key);
    const w = this.wgs.get(id);
    if (w === undefined) this.fatal(`${who} uses ${id}, which is not a waitgroup node`);
    if (op === "done") this.edge(g.id, id, "sync", "Done()");
    w.n += n;
    if (w.n < 0) {
      this.panicG(g, "sync: negative WaitGroup counter");
      return PARK;
    }
    const text = op === "done" ? `${who} calls ${w.label}.Done(): ${w.n} left.` : `${who} adds ${n} to ${w.label}: ${w.n}.`;
    if (w.n === 0) {
      for (const key of w.waiters) this.wake(key, undefined);
      w.waiters = [];
    }
    this.emit(g.key, op, text, { node: id });
    return undefined;
  }

  wgWait(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const w = this.wgs.get(id);
    if (w === undefined) this.fatal(`${who} waits on ${id}, which is not a waitgroup node`);
    this.edge(id, g.id, "sync", "Wait()");
    if (w.n === 0) {
      this.emit(g.key, "wait", `${w.label} is at 0, so ${who}'s Wait returns at once.`, { node: id });
      return undefined;
    }
    this.park(g, `${w.label}.Wait()`);
    w.waiters.push(g.key);
    this.emit(g.key, "wait", `${who} waits until ${w.label} reaches 0.`, { node: id, parked: true });
    return PARK;
  }

  lock(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const m = this.mutexes.get(id);
    if (m === undefined) this.fatal(`${who} locks ${id}, which is not a mutex node`);
    this.edge(id, g.id, "sync", "Lock()");
    if (m.holder === undefined) {
      m.holder = g.key;
      this.move(m.key, { node: g.key });
      this.emit(g.key, "lock", `${who} locks ${m.label}.`, { node: id });
      return undefined;
    }
    this.park(g, `${m.label}.Lock()`);
    g.waitMu = id;
    m.waiters.push(g.key);
    this.emit(g.key, "lock", `${who} waits for ${m.label}: ${this.name(m.holder)} holds it.`, { node: id, parked: true });
    return PARK;
  }

  unlock(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const m = this.mutexes.get(id);
    if (m === undefined) this.fatal(`${who} unlocks ${id}, which is not a mutex node`);
    if (m.holder === undefined) {
      this.panicG(g, `fatal error: sync: unlock of unlocked mutex ${m.label}`);
      return PARK;
    }
    if (m.waiters.length > 0) {
      // sync.Mutex promises no order, so the next holder is any waiter.
      const next = this.pick(m.waiters);
      m.waiters = m.waiters.filter((key) => key !== next);
      m.holder = next;
      this.move(m.key, { node: next }, id);
      this.wake(next, undefined);
      this.emit(g.key, "unlock", `${who} unlocks ${m.label}, and ${this.name(next)} gets it.`, { node: id });
    } else {
      m.holder = undefined;
      this.move(m.key, { node: id });
      this.emit(g.key, "unlock", `${who} unlocks ${m.label}.`, { node: id });
    }
    return undefined;
  }

  timerOp(g: GRT, op: "start" | "reset" | "stop", id: string): unknown {
    const who = this.name(g.key);
    const tm = this.timers.get(id);
    if (tm === undefined) this.fatal(`${who} uses ${id}, which is not a timer node`);
    this.edge(g.id, id, "sync", op === "stop" ? "Stop()" : op === "reset" ? "Reset()" : undefined);
    if (tm.pending !== undefined) {
      // Since Go 1.23, Reset and Stop discard a tick nobody received.
      this.move(tm.pending, { node: "gone" });
      tm.pending = undefined;
    }
    if (op === "stop") {
      tm.state = "stopped";
      tm.fireAt = undefined;
      this.emit(g.key, "stop", `${who} stops ${tm.label}.`, { node: id });
      return undefined;
    }
    tm.state = "running";
    tm.fireAt = later(this.t, tm.after);
    this.emit(g.key, op, `${who} ${op === "start" ? "starts" : "resets"} ${tm.label}: it fires in ${tm.after} ms.`, { node: id });
    return undefined;
  }

  fireTimer(tm: TimerRT): void {
    tm.state = "fired";
    tm.fireAt = undefined;
    const tick = this.newToken("", 1);
    this.glyphs.set(tick.id, "tick");
    this.locs.set(tick.id, { node: tm.id });
    this.moves.push({ tok: tick.id, from: { node: tm.id }, to: { node: tm.id }, born: true });
    const r = pop(tm.recvq);
    if (r !== undefined) {
      r.w.fired = true;
      this.dropHeld(r.w.g);
      this.move(tick, { node: r.w.g });
      this.wake(r.w.g, result(r, true, tick));
      this.emit("", "fire", `${tm.label} fires and wakes ${this.name(r.w.g)}.`, { node: tm.id });
    } else {
      tm.pending = tick;
      this.emit("", "fire", `${tm.label} fires; nobody is waiting yet.`, { node: tm.id });
    }
  }

  finishContext(c: CtxRT, cause: "deadline" | "cancel"): void {
    c.done = true;
    c.cause = cause;
    let r: Waiter | undefined;
    while ((r = pop(c.recvq)) !== undefined) {
      r.w.fired = true;
      this.wake(r.w.g, result(r, false, undefined));
    }
  }

  cancel(g: GRT, id: string): unknown {
    const who = this.name(g.key);
    const c = this.contexts.get(id);
    if (c === undefined) this.fatal(`${who} cancels ${id}, which is not a context node`);
    this.edge(g.id, id, "cancel");
    if (c.done) {
      this.emit(g.key, "cancel", `${who} calls cancel; ${c.label} is already done.`, { node: id });
      return undefined;
    }
    this.finishContext(c, "cancel");
    this.emit(g.key, "cancel", `${who} cancels ${c.label}: Done() closes.`, { node: id });
    return undefined;
  }

  put(g: GRT, id: string, i: number, v: Sendable, op: "put" | "append"): unknown {
    const who = this.name(g.key);
    const cells = this.slices.get(id);
    if (cells === undefined) this.fatal(`${who} writes to ${id}, which is not a slice node`);
    if (!Number.isInteger(i) || i < 0 || i >= cells.length) this.fatal(`${who} writes ${id}[${i}], outside its ${cells.length} cells`);
    const tok = this.tokenFor(g, v);
    const old = cells[i];
    if (old !== null && old !== undefined) this.move(old, { node: "gone" });
    cells[i] = tok;
    this.move(tok, { node: id, slot: i });
    this.edge(g.id, id, "data");
    this.emit(g.key, op, `${who} stores ${valueText(tok.v)} in ${this.label(id)}[${i}].`, { node: id, v: tok.v });
    return undefined;
  }

  panicG(g: GRT, text: string): void {
    g.status = "panicked";
    g.panic = text;
    g.why = undefined;
    this.halted = "panic";
    this.haltText = `${this.name(g.key)}: panic: ${text}`;
    this.emit(g.key, "panic", `${this.name(g.key)} panics: ${text}.`);
    throw new Halt(text);
  }

  exitAll(g: GRT, text: string): void {
    for (const other of this.goroutines.values()) {
      if (other.started && other.status !== "done" && other.status !== "panicked") {
        other.status = "done";
        other.why = "killed";
        this.dropHeld(other.key);
      }
    }
    // Nobody is left to wait: the dead goroutines leave every queue.
    for (const c of this.channels.values()) {
      c.sendq = [];
      c.recvq = [];
    }
    for (const tm of this.timers.values()) tm.recvq = [];
    for (const c of this.contexts.values()) c.recvq = [];
    for (const m of this.mutexes.values()) m.waiters = [];
    for (const w of this.wgs.values()) w.waiters = [];
    this.halted = "exit";
    this.haltText = text;
    this.emit(g.key, "exit", `${text}: the process exits.`);
    throw new Halt(text);
  }

  // ---- the end -------------------------------------------------------------

  // A ring of goroutines, each waiting for a mutex the next one holds:
  // P0 → P1 → … → P0. Undefined when the waits form no ring.
  lockCycle(live: GRT[]): string[] | undefined {
    const next = (g: GRT): GRT | undefined => {
      if (g.waitMu === undefined) return undefined;
      const holder = this.mutexes.get(g.waitMu)?.holder;
      return holder === undefined ? undefined : this.goroutines.get(holder);
    };
    for (const start of live) {
      const path: string[] = [];
      let g: GRT | undefined = start;
      while (g !== undefined && !path.includes(g.key)) {
        path.push(g.key);
        g = next(g);
      }
      if (g !== undefined && g.key === start.key && path.length > 1) return [...path, start.key];
    }
    return undefined;
  }

  conclude(): { outcome: Outcome; verdict: string } {
    if (this.halted === "panic") return { outcome: "panic", verdict: `Panic: ${this.haltText}.` };
    if (this.halted === "exit") return { outcome: "exit", verdict: `${this.haltText}: the process exits at once.` };
    const live = [...this.goroutines.values()].filter((g) => g.started && g.status !== "done" && g.status !== "panicked");
    if (live.length === 0) return { outcome: "ok", verdict: "" };
    const busy = live.filter((g) => g.status === "working" || g.wake !== undefined || g.status === "running");
    // A run that stops at `until` with everything blocked is still a leak or
    // a deadlock; only a goroutine still working or sleeping makes a timeout.
    if (busy.length > 0) {
      const who = (busy[0] ?? live[0])!;
      const doing = who.status === "working" ? (who.label ?? "working") : `blocked on ${who.why ?? "something"}`;
      return { outcome: "timeout", verdict: `Still running at ${this.t} ms (${this.name(who.key)}: ${doing}).` };
    }
    const main = [...this.goroutines.values()].find((g) => g.def.main === true);
    const leak = main !== undefined && main.status === "done";
    for (const g of live) g.status = leak ? "leaked" : "deadlocked";
    const named = groupNames(live.map((g) => [this.name(g.key), g.why ?? "?"]));
    this.emit("", "end", leak ? "Main has returned; the rest wait forever." : "Every goroutine waits; nothing can wake them.");
    if (leak) {
      return {
        outcome: "leak",
        verdict:
          live.length === 1
            ? `Leak: ${named[0]} forever, with nobody left to wake it.`
            : `Leak: ${named.slice(0, 2).join("; ")}${named.length > 2 ? `; +${named.length - 2} more` : ""}. Nobody is left to wake them.`,
      };
    }
    const cycle = this.lockCycle(live);
    if (cycle !== undefined) {
      return {
        outcome: "deadlock",
        verdict: `Deadlock: ${cycle.map((key) => this.name(key)).join(" → ")}, each waiting for a lock the next one holds.`,
      };
    }
    return {
      outcome: "deadlock",
      verdict: `Deadlock: every goroutine is blocked: ${named.slice(0, 3).join("; ")}${named.length > 3 ? `; +${named.length - 3} more` : ""}.`,
    };
  }
}

// A time ms after t, in whole microseconds, so ten 0.01 ms steps end at
// 0.1 ms, not 0.0999….
function later(t: number, ms: number): number {
  return ms === Infinity ? Infinity : Math.round((t + ms) * 1000) / 1000;
}

const PARK = Symbol("park");

function live(queue: readonly Waiter[]): number {
  return queue.filter((waiter) => !waiter.w.fired).length;
}

function pop(queue: Waiter[]): Waiter | undefined {
  while (queue.length > 0) {
    const waiter = queue.shift()!;
    if (!waiter.w.fired) return waiter;
  }
  return undefined;
}

function result(waiter: Waiter, ok: boolean, tok: Token | undefined): RecvResult | SelectResult {
  return withCase({ ok, v: tok?.v ?? null, tok }, waiter.i, waiter.select === true);
}

function withCase(r: RecvResult, i: number, isSelect: boolean): RecvResult | SelectResult {
  return isSelect ? { ...r, i } : r;
}

// What a goroutine view draws, for change detection.
function drawn(view: GView): string {
  return `${view.status}|${view.why ?? ""}|${view.label ?? ""}|${view.status === "working" ? (view.workStart ?? "") : ""}`;
}

// "worker-1 is blocked on out <-" with members on one target collapsed:
// "worker ×9 are blocked on fan-in <-".
function groupNames(items: [string, string][]): string[] {
  const groups = new Map<string, string[]>();
  for (const [name, why] of items) {
    const base = name.replace(/-\d+$/, "");
    const key = `${base}\u0000${why}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.entries()].map(([key, names]) => {
    const [base, why] = key.split("\u0000") as [string, string];
    if (names.length === 1) return `${names[0]} is blocked on ${why}`;
    return `${base} ×${names.length} are blocked on ${why}`;
  });
}

// The Go text an operation usually sits on, for the code panel.
function autoNeedles(op: Op, label: (id: string) => string): string[] {
  switch (op.op) {
    case "send":
      return [`${label(op.ch)} <-`];
    case "recv":
      return [`<-${label(op.ch)}`, `range ${label(op.ch)}`];
    case "select":
      return ["select {"];
    case "close":
      return [`close(${label(op.ch)})`];
    case "work":
      return op.label === undefined ? [] : [op.label.includes("(") ? op.label : `${op.label}(`];
    case "sleep":
      return ["time.Sleep"];
    case "go":
      return ["go "];
    case "add":
      return [`${label(op.wg)}.Add(`];
    case "done":
      return [`${label(op.wg)}.Done()`];
    case "wait":
      return [`${label(op.wg)}.Wait()`];
    case "lock":
      return [`${label(op.mu)}.Lock()`];
    case "unlock":
      return [`${label(op.mu)}.Unlock()`];
    case "reset":
      return [`${label(op.timer)}.Reset(`];
    case "stop":
      return [`${label(op.timer)}.Stop()`];
    case "cancel":
      return ["cancel("];
    case "put":
      return [`${label(op.slice)}[`];
    case "append":
      return [`append(${label(op.slice)}`];
    case "print":
      return ["fmt.Print"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RunOptions {
  P?: Params;
  seed?: number;
}

export function runModel(model: Model, options: RunOptions = {}): Run {
  const sim = new Sim(model, options.P ?? {}, options.seed ?? 1);
  const initial = sim.last;
  sim.run();
  let concluded: { outcome: Outcome; verdict: string };
  try {
    concluded = sim.conclude();
  } catch (error) {
    // The closing step itself can pass the step limit.
    if (!(error instanceof Halt)) throw error;
    concluded = { outcome: "panic", verdict: `Panic: ${sim.haltText}.` };
  }
  const { outcome, verdict } = concluded;

  // Judge the tests nobody marked, on the finished run.
  const summary: RunSummary = {
    outcome,
    t: sim.t,
    world: sim.last,
    vars: sim.vars,
    peak: sim.peak,
    events: sim.steps.map((s) => s.event),
  };
  let judged = false;
  for (const [id, test] of Object.entries(model.tests ?? {})) {
    if (sim.tests.has(id) || test.judge === undefined) continue;
    sim.tests.set(id, test.judge(summary) ? "pass" : "fail");
    judged = true;
  }
  if (judged || sim.steps.length === 0 || sim.last.t !== sim.t) {
    const world = sim.snapshot();
    sim.steps.push({
      event: { t: sim.t, g: "", op: "end", text: verdict === "" ? "Every goroutine has returned." : verdict },
      moves: [],
      changed: [],
      world,
    });
    sim.last = world;
  }

  const events = sim.steps.map((s) => s.event);
  return {
    outcome,
    t: sim.t,
    world: sim.last,
    vars: sim.vars,
    peak: sim.peak,
    events,
    initial,
    steps: sim.steps,
    edges: [...sim.edges.values()],
    verdict,
    errors: sim.errors,
    stopAt: resolveStops(model, events),
    owners: sim.owners,
  };
}

export function runScene(scene: SceneDef, options: RunOptions = {}): Run {
  const P = options.P ?? defaultParams(scene);
  return runModel(resolveModel(scene, P), { ...options, P });
}

export function matches(event: Event, match: NonNullable<Model["stops"]>[number]["when"]): boolean {
  if (match.op !== undefined) {
    if (match.op === "block") {
      if (event.parked !== true) return false;
    } else if (event.op !== match.op) return false;
  }
  if (match.g !== undefined && event.g !== match.g && nodeOf(event.g) !== match.g) return false;
  if (match.node !== undefined && event.node !== match.node) return false;
  if (match.t !== undefined && event.t < match.t) return false;
  return true;
}

function resolveStops(model: Model, events: readonly Event[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const stop of model.stops ?? []) {
    let seen = 0;
    let found = -1;
    for (let i = from; i < events.length; i++) {
      if (!matches(events[i]!, stop.when)) continue;
      seen++;
      if (seen >= (stop.when.nth ?? 1)) {
        found = i;
        break;
      }
    }
    out.push(found);
    if (found >= 0) from = found + 1;
  }
  return out;
}

export function opNames(): OpName[] {
  return [
    "work", "sleep", "send", "recv", "select", "close", "remake", "notify", "go", "add", "done", "wait", "lock", "unlock",
    "start", "reset", "stop", "cancel", "put", "append", "set", "inc", "print", "pass", "fail", "panic", "exit",
  ];
}

// Every node a scene uses, across all knob combinations, for the checks.
export function specScenes(spec: VizSpec): SceneDef[] {
  return [...spec.scenes];
}

export type { ChannelNode, ContextNode };
