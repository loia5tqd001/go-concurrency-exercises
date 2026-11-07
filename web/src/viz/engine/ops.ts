// The author's vocabulary. A spec builds nodes with the node helpers and
// writes each goroutine's program with the operation helpers:
//
//   program: function* () {
//     for (let n = 1; n <= 8; n++) {
//       yield work(25, "produce");
//       yield send("out", n);
//     }
//     yield close("out");
//   }
//
// One operation is one Go statement. The scheduler decides when it runs.

import type {
  ChannelNode,
  ContextNode,
  FactNode,
  GoroutineNode,
  MutexNode,
  Op,
  OpBase,
  RecvResult,
  SelectCase,
  Sendable,
  SliceNode,
  TimerNode,
  Value,
  VizSpec,
  WaitGroupNode,
} from "./model.ts";

type Opts = OpBase;
type Def<T> = Omit<T, "kind">;

// The value of a value-less send: struct{}{}. It draws as a dot.
export const SIGNAL = "•";

export function defineViz(spec: VizSpec): VizSpec {
  return spec;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export const goroutine = (def: Def<GoroutineNode>): GoroutineNode => ({ kind: "goroutine", ...def });
export const channel = (def: Def<ChannelNode>): ChannelNode => ({ kind: "channel", ...def });
export const waitgroup = (def: Def<WaitGroupNode>): WaitGroupNode => ({ kind: "waitgroup", ...def });
export const mutex = (def: Def<MutexNode>): MutexNode => ({ kind: "mutex", ...def });
export const slice = (def: Def<SliceNode>): SliceNode => ({ kind: "slice", ...def });
export const timer = (def: Def<TimerNode>): TimerNode => ({ kind: "timer", ...def });
export const context = (def: Def<ContextNode>): ContextNode => ({ kind: "context", ...def });
export const fact = (def: Def<FactNode>): FactNode => ({ kind: "fact", ...def });

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// The goroutine computes for ms. It stays running, with a progress bar.
export const work = (ms: number, label?: string, o: Opts = {}): Op => ({ op: "work", ms, label, ...o });
// time.Sleep: the goroutine is blocked until ms pass.
export const sleep = (ms: number, o: Opts = {}): Op => ({ op: "sleep", ms, ...o });
// ch <- v. Pass the received token to forward the same item.
export const send = (ch: string, v: Sendable, o: Opts = {}): Op => ({ op: "send", ch, v, ...o });
// <-ch. Yields a RecvResult: { ok, v, tok }.
export const recv = (ch: string, o: Opts = {}): Op => ({ op: "recv", ch, ...o });
export const close = (ch: string, o: Opts = {}): Op => ({ op: "close", ch, ...o });
// ch = make(chan T, n) on a variable that held an earlier channel: the node
// becomes a fresh, open, empty channel. Nobody may still wait on the old one.
export const remake = (ch: string, o: Opts = {}): Op => ({ op: "remake", ch, ...o });
// A runtime send that never blocks and drops the value when the buffer is
// full: signal.Notify.
export const notify = (ch: string, v: Sendable, o: Opts = {}): Op => ({ op: "notify", ch, v, ...o });

// select over cases. Yields a SelectResult: { i, ok, v, tok }, with i = -1
// when `default` ran. With two or more ready cases the scheduler picks one at
// random, as Go does.
export const select = (cases: readonly SelectCase[], o: Opts & { default?: boolean } = {}): Op => ({
  op: "select",
  cases,
  ...o,
});
export const onRecv = (ch: string): SelectCase => ({ dir: "recv", ch });
export const onSend = (ch: string, v: Sendable): SelectCase => ({ dir: "send", ch, v });

// go f(): start a spawned goroutine. Name a member (worker[3]), every member
// (worker[*]), or a single goroutine (closer).
export const go = (target: string, o: Opts = {}): Op => ({ op: "go", target, ...o });

export const add = (wg: string, n: number, o: Opts = {}): Op => ({ op: "add", wg, n, ...o });
export const done = (wg: string, o: Opts = {}): Op => ({ op: "done", wg, ...o });
export const wait = (wg: string, o: Opts = {}): Op => ({ op: "wait", wg, ...o });

export const lock = (mu: string, o: Opts = {}): Op => ({ op: "lock", mu, ...o });
export const unlock = (mu: string, o: Opts = {}): Op => ({ op: "unlock", mu, ...o });

export const start = (t: string, o: Opts = {}): Op => ({ op: "start", timer: t, ...o });
export const reset = (t: string, o: Opts = {}): Op => ({ op: "reset", timer: t, ...o });
export const stop = (t: string, o: Opts = {}): Op => ({ op: "stop", timer: t, ...o });

export const cancel = (ctx: string, o: Opts = {}): Op => ({ op: "cancel", ctx, ...o });

// s[i] = v
export const put = (s: string, i: number, v: Sendable, o: Opts = {}): Op => ({ op: "put", slice: s, i, v, ...o });
// s = append(s, v)
export const append = (s: string, v: Sendable, o: Opts = {}): Op => ({ op: "append", slice: s, v, ...o });

export const set = (f: string, v: Value, o: Opts = {}): Op => ({ op: "set", fact: f, v, ...o });
export const inc = (f: string, n = 1, o: Opts = {}): Op => ({ op: "inc", fact: f, n, ...o });

// fmt.Println(v): the value lands in the output strip.
export const print = (v: Sendable, o: Opts = {}): Op => ({ op: "print", v, ...o });

export const pass = (test: string): Op => ({ op: "pass", test });
export const fail = (test: string): Op => ({ op: "fail", test });

export const panic = (text: string, o: Opts = {}): Op => ({ op: "panic", text, ...o });
// os.Exit, or a signal's default action: the whole process ends at once.
export const exit = (text: string, o: Opts = {}): Op => ({ op: "exit", text, ...o });

// for v := range ch { body(v) }. Use it with yield*:
//
//   yield* range("in", function* (r) { yield send("out", r.tok!); });
export function* range(
  ch: string,
  body: (r: RecvResult) => Generator<Op, void, unknown>,
  o: Opts = {},
): Generator<Op, void, RecvResult> {
  for (;;) {
    const r: RecvResult = yield recv(ch, o);
    if (!r.ok) return;
    yield* body(r) as Generator<Op, void, RecvResult>;
  }
}
