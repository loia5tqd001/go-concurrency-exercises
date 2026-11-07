// The graph: goroutines, channels, and the objects they share as nodes, the
// operations between them as edges, and values as tokens that fly along the
// edges. Every colour comes from a CSS class, so both themes work and a spec
// never picks one.

import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { Beat } from "../engine/timeline.ts";
import { anchor, centre, labelRoom, type EdgePath, type Layout, type NodeBox } from "../engine/layout.ts";
import type { GView, Loc, Move, NodeDef, TokenView, World } from "../engine/model.ts";
import { memberKeys, valueText } from "../engine/sim.ts";

export interface GraphProps {
  lay: Layout;
  beat: Beat | undefined;
  f: number;
  t: number;
  initial: World;
  focus: string | null;
  onFocus: (id: string | null, pin: boolean) => void;
  label: string;
}

export function Graph({ lay, beat, f, t, initial, focus, onFocus, label }: GraphProps) {
  // Marker ids are per graph: two players can share a page, and a url(#id)
  // resolves to the first element with that id in the document.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const from = beat?.from ?? initial;
  const to = beat?.to ?? initial;
  // Node states switch halfway through a batch, when the values are in the
  // air; during a time beat nothing but the clock changes.
  const world = beat?.kind === "batch" && f >= 0.5 ? to : from;
  const shown = beat?.kind === "batch" ? to : from;

  return (
    <svg
      className="sim-graph"
      width={Math.round(lay.width * lay.scale)}
      height={Math.round(lay.height * lay.scale)}
      viewBox={`0 0 ${lay.width} ${lay.height}`}
      role="group"
      aria-label={label}
    >
      <defs>
        {(["data", "close", "sync", "spawn", "cancel"] as const).map((type) => (
          <marker
            key={type}
            id={`sim-arrow-${uid}-${type}`}
            className={`sim-arrow is-${type}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        ))}
      </defs>
      <g className="sim-edges">
        {lay.edges.map((edge) => (
          <EdgeLine key={`${edge.from}>${edge.to}>${edge.type}`} edge={edge} uid={uid} />
        ))}
      </g>
      <g className="sim-nodes">
        {Object.values(lay.nodes).map((node) => (
          <NodeShape
            key={node.id}
            node={node}
            lay={lay}
            world={world}
            t={t}
            focused={focus === node.id}
            onFocus={onFocus}
          />
        ))}
      </g>
      <Tokens lay={lay} beat={beat} f={f} from={from} shown={shown} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function EdgeLine({ edge, uid }: { edge: EdgePath; uid: string }) {
  const d = edge.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  let labelAt: [number, number] | undefined;
  if (edge.label !== undefined) {
    const pts = edge.points;
    const a = pts.length > 2 ? pts[1]! : pts[0]!;
    const b = pts.length > 2 ? pts[2]! : pts[pts.length - 1]!;
    // A label on a short edge would sit on a node; the edge's style still
    // says what it is.
    const room = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (room >= edge.label.length * 6.5 + 28) labelAt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return (
    <g className={`sim-edge is-${edge.type}`}>
      <path d={d} markerEnd={`url(#sim-arrow-${uid}-${edge.type})`} />
      {labelAt !== undefined && (
        <text x={labelAt[0]} y={labelAt[1] - 4} className="sim-edge-label" textAnchor="middle">
          {edge.label}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface NodeProps {
  node: NodeBox;
  lay: Layout;
  world: World;
  t: number;
  focused: boolean;
  onFocus: (id: string | null, pin: boolean) => void;
}

function NodeShape(props: NodeProps) {
  const { node } = props;
  switch (node.def.kind) {
    case "goroutine":
      return node.def.count === undefined ? <GoroutineShape {...props} /> : <GroupShape {...props} />;
    case "channel":
      return <ChannelShape {...props} />;
    case "slice":
      return <SliceShape {...props} />;
    case "waitgroup":
      return <PillShape {...props} text={`${node.def.label} ${props.world.wg[node.id]?.n ?? 0}`} kind="wg" />;
    case "mutex":
      return <MutexShape {...props} />;
    case "cond":
      return (
        <PillShape
          {...props}
          text={`${node.def.label} ${props.world.cond[node.id]?.waiters ?? 0}`}
          kind="cond"
        />
      );
    case "timer":
      return <TimerShape {...props} />;
    case "context":
      return <ContextShape {...props} />;
    case "fact":
      return <FactShape {...props} />;
  }
}

export function statusText(view: GView | undefined): string {
  if (view === undefined) return "";
  switch (view.status) {
    case "idle":
      return "not started";
    case "running":
      return "running";
    case "working":
      return view.label ?? "working";
    case "blocked":
    case "leaked":
    case "deadlocked":
      return view.why ?? "blocked";
    case "done":
      return view.why === "killed" ? "killed" : "returned";
    case "panicked":
      return "panic";
  }
}

export function statusWord(view: GView | undefined): string {
  if (view === undefined) return "";
  switch (view.status) {
    case "idle":
      return "not started";
    case "working":
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "leaked":
      return "leaked";
    case "deadlocked":
      return "deadlocked";
    case "done":
      return view.why === "killed" ? "killed" : "returned";
    case "panicked":
      return "panicked";
  }
}

function tone(status: GView["status"] | undefined): string {
  switch (status) {
    case "working":
    case "running":
      return "is-run";
    case "blocked":
      return "is-wait";
    case "leaked":
    case "deadlocked":
    case "panicked":
      return "is-bad";
    case "done":
      return "is-done";
    default:
      return "is-idle";
  }
}

function focusable(id: string, onFocus: NodeProps["onFocus"], name: string) {
  return {
    tabIndex: 0,
    role: "button",
    "aria-label": name,
    onPointerEnter: (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") onFocus(id, false);
    },
    onPointerLeave: (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") onFocus(null, false);
    },
    onClick: () => onFocus(id, true),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        onFocus(id, true);
      }
    },
  };
}

function progress(view: GView | undefined, t: number): number | undefined {
  if (view?.status !== "working" || view.workStart === undefined || view.workEnd === undefined) return undefined;
  if (view.workEnd === Infinity) return -1;
  const span = view.workEnd - view.workStart;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (t - view.workStart) / span));
}

function GoroutineShape({ node, world, t, focused, onFocus }: NodeProps) {
  const view = world.g[node.id];
  const x0 = node.x - node.w / 2;
  const y0 = node.y - node.h / 2;
  const p = progress(view, t);
  const why = compact(statusText(view), node.w - 10, 11);
  return (
    <g
      className={`sim-node sim-go ${tone(view?.status)}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `${node.def.label}: ${statusWord(view)}${why !== statusWord(view) ? `, ${why}` : ""}`)}
    >
      <rect className="sim-shape" x={x0} y={y0} width={node.w} height={node.h} rx={11} />
      <text className="sim-name" x={node.x} y={node.y - 3} textAnchor="middle" style={{ fontSize: fitSize(node.def.label, node.w - 10, 12.5) }}>
        {fitText(node.def.label, node.w - 10, 12.5)}
      </text>
      <text className="sim-why" x={node.x} y={node.y + 13} textAnchor="middle" style={{ fontSize: fitSize(why, node.w - 10, 11) }}>
        {fitText(why, node.w - 10, 11)}
      </text>
      {p !== undefined && (
        // A bar inset inside the box, clear of its rounded corners, so it
        // needs no clip path: an id would collide when two players share a
        // page.
        <g className="sim-progress">
          <rect
            x={x0 + 8}
            y={y0 + node.h - 6}
            width={(node.w - 16) * (p < 0 ? 1 : p)}
            height={3}
            rx={1.5}
            className={p < 0 ? "is-endless" : undefined}
          />
        </g>
      )}
    </g>
  );
}

function GroupShape({ node, lay, world, t, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "goroutine") return null;
  const keys = memberKeys(node.id, node.def);
  const views = keys.map((key) => world.g[key]);
  const counts = new Map<string, number>();
  for (const view of views) {
    const word = statusWord(view);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([word, n]) => `${n} ${word}`).join(", ");
  const head = views.some((v) => v?.status === "leaked" || v?.status === "deadlocked" || v?.status === "panicked")
    ? "is-bad"
    : views.some((v) => v?.status === "working" || v?.status === "running")
      ? "is-run"
      : views.some((v) => v?.status === "blocked")
        ? "is-wait"
        : views.every((v) => v?.status === "done")
          ? "is-done"
          : "is-idle";
  // One line under the name: what most members do right now.
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const doing = views.find((v) => statusWord(v) === busiest?.[0]);
  const x0 = node.x - node.w / 2;
  const y0 = node.y - node.h / 2;
  return (
    <g
      className={`sim-node sim-group ${head}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `${node.def.label} ×${keys.length}: ${summary}`)}
    >
      <rect className="sim-shape" x={x0} y={y0} width={node.w} height={node.h} rx={11} />
      <text className="sim-name" x={x0 + 9} y={y0 + 16}>
        {node.def.label}
        <tspan className="sim-count"> ×{keys.length}</tspan>
      </text>
      <text className="sim-why" x={x0 + 9} y={y0 + 30} style={{ fontSize: fitSize(statusText(doing), node.w - 18, 11) }}>
        {fitText(statusText(doing), node.w - 18, 11)}
      </text>
      {keys.map((key, k) => {
        const cell = lay.members[key];
        const view = views[k];
        if (cell === undefined) return null;
        const p = progress(view, t);
        return (
          <g key={key} className={`sim-member ${tone(view?.status)}`}>
            <rect x={cell.x - cell.w / 2} y={cell.y - cell.h / 2} width={cell.w} height={cell.h} rx={3} />
            {p !== undefined && p >= 0 && (
              <rect
                className="sim-member-fill"
                x={cell.x - cell.w / 2}
                y={cell.y + cell.h / 2 - cell.h * p}
                width={cell.w}
                height={cell.h * p}
                rx={2}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

function ChannelShape({ node, lay, world, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "channel") return null;
  const view = world.ch[node.id];
  const closed = view?.closed === true;
  const slots = lay.slots[node.id] ?? [];
  const title = node.def.cap > 0 ? `${node.def.label}` : node.def.label;
  const waiting = (view?.senders ?? 0) + (view?.receivers ?? 0);
  const more = view !== undefined && slots.length > 0 && view.buf.length > slots.length ? view.buf.length - slots.length + 1 : 0;
  const full = !closed && waiting > 0 && node.def.cap > 0 && view !== undefined && view.buf.length >= node.def.cap;
  // A closed, empty channel says so inside its box, where no edge runs. A
  // closed channel that still holds values shows them; its dashed outline
  // says closed.
  const closedInside = closed && (view?.buf.length ?? 0) === 0;
  const state =
    more > 0 ? { word: `+${more}`, cls: "sim-more" } : full ? { word: "full", cls: "sim-note" } : undefined;
  return (
    <g
      className={`sim-node sim-ch${closed ? " is-closed" : ""}${focused ? " is-focus" : ""}`}
      {...focusable(
        node.id,
        onFocus,
        `channel ${node.def.label}, capacity ${node.def.cap}, ${view?.buf.length ?? 0} queued${closed ? ", closed" : ""}`,
      )}
    >
      {/* The state word rides with the name, clear of every edge: above
          the box when data flows left to right, on its upper right corner
          when it flows top to bottom. */}
      {!lay.portrait && (
        <text className="sim-label" x={node.x} y={node.y - node.h / 2 - 5} textAnchor="middle">
          {node.def.label}
          {node.def.cap > 0 && <tspan className="sim-cap">{`  cap ${node.def.cap}`}</tspan>}
          {state !== undefined && <tspan className={state.cls}>{`  ${state.word}`}</tspan>}
        </text>
      )}
      <rect className="sim-shape" x={node.x - node.w / 2} y={node.y - node.h / 2} width={node.w} height={node.h} rx={8} />
      {lay.portrait && (
        <text className="sim-label" x={node.x} y={node.y - 6} textAnchor="middle">
          {node.def.label}
          {state !== undefined && <tspan className={state.cls}>{` ${state.word}`}</tspan>}
        </text>
      )}
      {closedInside ? (
        <text className="sim-closed" x={node.x} y={lay.portrait ? node.y + 13 : node.y + 4} textAnchor="middle">
          closed
        </text>
      ) : (
        slots.map((slot, k) => (
          <circle
            key={k}
            className={node.def.kind === "channel" && node.def.cap === 0 ? "sim-slot is-handoff" : "sim-slot"}
            cx={slot.x}
            cy={slot.y}
            r={Math.min(lay.r - 1, slot.w / 2)}
          />
        ))
      )}
      <title>{title}</title>
    </g>
  );
}

function SliceShape({ node, lay, world, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "slice") return null;
  const cells = lay.slots[node.id] ?? [];
  const filled = world.slice[node.id]?.filter((cell) => cell !== null).length ?? 0;
  return (
    <g
      className={`sim-node sim-slice${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `${node.def.label}: ${filled} of ${node.def.size} filled`)}
    >
      <text
        className="sim-label"
        x={lay.portrait ? node.x - node.w / 2 : node.x}
        y={lay.portrait ? node.y + node.h / 2 + 14 : node.y - node.h / 2 - 5}
        textAnchor={lay.portrait ? "start" : "middle"}
      >
        {node.def.label}
        <tspan className="sim-cap">{`  ${filled}/${node.def.size}`}</tspan>
      </text>
      <rect className="sim-shape" x={node.x - node.w / 2} y={node.y - node.h / 2} width={node.w} height={node.h} rx={6} />
      {cells.map((cell, k) => (
        <rect
          key={k}
          className="sim-cellslot"
          x={cell.x - cell.w / 2}
          y={cell.y - cell.h / 2}
          width={cell.w}
          height={cell.h}
          rx={Math.min(4, cell.w / 3)}
        />
      ))}
    </g>
  );
}

function PillShape({ node, focused, onFocus, text, kind }: NodeProps & { text: string; kind: string }) {
  return (
    <g className={`sim-node sim-pill is-${kind}${focused ? " is-focus" : ""}`} {...focusable(node.id, onFocus, text)}>
      <rect className="sim-shape" x={node.x - node.w / 2} y={node.y - node.h / 2} width={node.w} height={node.h} rx={node.h / 2} />
      <text className="sim-name" x={node.x} y={node.y + 4} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

function MutexShape({ node, lay, world, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "mutex") return null;
  const view = world.mu[node.id];
  const [kx, ky] = anchor(lay, { node: node.id });
  return (
    <g
      className={`sim-node sim-pill is-mu${view?.holder !== undefined ? " is-held" : ""}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `mutex ${node.def.label}: ${view?.holder === undefined ? "free" : "locked"}`)}
    >
      <rect className="sim-shape" x={node.x - node.w / 2} y={node.y - node.h / 2} width={node.w} height={node.h} rx={8} />
      <text className="sim-name" x={node.x - node.w / 2 + 10} y={node.y + 4}>
        {node.def.label}
      </text>
      <circle className="sim-slot" cx={kx} cy={ky} r={lay.r - 1} />
    </g>
  );
}

function TimerShape({ node, world, t, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "timer") return null;
  const view = world.timer[node.id];
  const after = node.def.after;
  let left = 0;
  let word = "not started";
  if (view?.state === "running" && view.fireAt !== undefined) {
    left = Math.max(0, view.fireAt - t);
    word = `${Math.round(left)} ms`;
  } else if (view?.state === "fired") word = "fired";
  else if (view?.state === "stopped") word = "stopped";
  const x0 = node.x - node.w / 2;
  const barX = x0 + 10 + node.def.label.length * 7.3 + 6;
  const barW = Math.max(20, node.x + node.w / 2 - 10 - barX);
  return (
    <g
      className={`sim-node sim-pill is-timer is-${view?.state ?? "idle"}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `timer ${node.def.label}: ${word}`)}
    >
      <rect className="sim-shape" x={x0} y={node.y - node.h / 2} width={node.w} height={node.h} rx={8} />
      <text className="sim-name" x={x0 + 10} y={node.y + 1}>
        {node.def.label}
      </text>
      <rect className="sim-bar-track" x={barX} y={node.y - 7} width={barW} height={5} rx={2.5} />
      <rect className="sim-bar" x={barX} y={node.y - 7} width={barW * (after > 0 ? left / after : 0)} height={5} rx={2.5} />
      <text className="sim-why" x={barX} y={node.y + 11}>
        {word}
      </text>
    </g>
  );
}

function ContextShape({ node, world, t, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "context") return null;
  const view = world.ctx[node.id];
  const done = view?.done === true;
  let word = done ? (view?.cause === "deadline" ? "expired" : "cancelled") : "live";
  if (!done && node.def.deadline !== undefined) word = `${Math.max(0, Math.round(node.def.deadline - t))} ms left`;
  return (
    <g
      className={`sim-node sim-pill is-ctx${done ? " is-done-ctx" : ""}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `context ${node.def.label}: ${word}`)}
    >
      <rect className="sim-shape" x={node.x - node.w / 2} y={node.y - node.h / 2} width={node.w} height={node.h} rx={node.h / 2} />
      <text className="sim-name" x={node.x} y={node.y - 1} textAnchor="middle">
        {node.def.label}
      </text>
      <text className="sim-why" x={node.x} y={node.y + 11} textAnchor="middle">
        {word}
      </text>
    </g>
  );
}

function FactShape({ node, world, focused, onFocus }: NodeProps) {
  if (node.def.kind !== "fact") return null;
  const def = node.def;
  const value = world.fact[node.id] ?? def.value;
  const x0 = node.x - node.w / 2;
  const y0 = node.y - node.h / 2;
  const over = def.limit !== undefined && typeof value === "number" && value > def.limit;
  let body: ReactNode;
  if (def.states !== undefined) {
    // The pills shrink together to fit the box, down to 8.5 px type.
    const natural = def.states.reduce((sum, state) => sum + state.length * 6.2 + 12 + 4, -4);
    const k = Math.max(8.5 / 10.5, Math.min(1, (node.w - 16) / natural));
    let x = x0 + 8;
    body = def.states.map((state) => {
      const w = (state.length * 6.2 + 12) * k;
      const pill = (
        <g key={state} className={`sim-state${state === value ? " is-on" : ""}`}>
          <rect x={x} y={node.y + 1} width={w} height={16} rx={8} />
          <text x={x + w / 2} y={node.y + 13} textAnchor="middle" style={{ fontSize: `${10.5 * k}px` }}>
            {state}
          </text>
        </g>
      );
      x += w + 4 * k;
      return pill;
    });
  } else if (def.limit !== undefined) {
    const n = typeof value === "number" ? value : 0;
    const barX = x0 + 10;
    const barW = node.w - 20;
    const scale = Math.max(def.limit * 1.5, n, 1);
    body = (
      <>
        <rect className="sim-bar-track" x={barX} y={node.y + 8} width={barW} height={5} rx={2.5} />
        <rect className={`sim-bar${over ? " is-over" : ""}`} x={barX} y={node.y + 8} width={(barW * n) / scale} height={5} rx={2.5} />
        <line className="sim-limit" x1={barX + (barW * def.limit) / scale} x2={barX + (barW * def.limit) / scale} y1={node.y + 4} y2={node.y + 17} />
      </>
    );
  }
  const head = def.states !== undefined ? def.label : `${def.label} ${valueText(value)}${def.unit !== undefined ? ` ${def.unit}` : ""}`;
  return (
    <g
      className={`sim-node sim-fact${over ? " is-over" : ""}${focused ? " is-focus" : ""}`}
      {...focusable(node.id, onFocus, `${def.label}: ${valueText(value)}${def.limit !== undefined ? `, limit ${def.limit}` : ""}`)}
    >
      <rect className="sim-shape" x={x0} y={y0} width={node.w} height={node.h} rx={8} />
      <text className="sim-name" x={def.states !== undefined || def.limit !== undefined ? x0 + 10 : node.x} y={def.states !== undefined ? node.y - 6 : def.limit !== undefined ? node.y - 2 : node.y + 4} textAnchor={def.states !== undefined || def.limit !== undefined ? "start" : "middle"}>
        {head}
        {def.limit !== undefined && <tspan className="sim-cap">{`  ${over ? ">" : "≤"} ${def.limit}`}</tspan>}
      </text>
      {body}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Where each token rests in a world. A goroutine holds its tokens in a row.
function spots(lay: Layout, world: World): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const held = new Map<string, number>();
  const ids = Object.keys(world.tokens)
    .map(Number)
    .sort((a, b) => a - b);
  for (const id of ids) {
    const tok = world.tokens[id]!;
    let k = 0;
    if (lay.slots[tok.at.node] === undefined && lay.members[tok.at.node] === undefined) {
      k = held.get(tok.at.node) ?? 0;
      held.set(tok.at.node, k + 1);
    }
    out.set(id, anchor(lay, tok.at, k));
  }
  return out;
}

function ease(f: number): number {
  return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
}

function along(points: [number, number][], f: number): [number, number] {
  if (points.length === 1) return points[0]!;
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total === 0) return points[points.length - 1]!;
  let left = f * total;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (left <= len || i === lengths.length - 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const s = len === 0 ? 1 : Math.min(1, left / len);
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
    }
    left -= len;
  }
  return points[points.length - 1]!;
}

interface TokensProps {
  lay: Layout;
  beat: Beat | undefined;
  f: number;
  from: World;
  shown: World;
}

function Tokens({ lay, beat, f, from, shown }: TokensProps) {
  const fromSpots = spots(lay, from);
  const toSpots = spots(lay, shown);
  const moving = new Map<number, Move>();
  if (beat?.kind === "batch") for (const m of beat.moves) moving.set(m.tok, m);
  const e = ease(f);

  const items: ReactNode[] = [];
  const draw = (id: number, tok: TokenView, at: [number, number], opacity: number, flying: boolean, loc: Loc): void => {
    items.push(
      <TokenDot key={id} tok={tok} x={at[0]} y={at[1]} r={radiusAt(lay, loc)} opacity={opacity} flying={flying} />,
    );
  };

  // Tokens that rest or fly in this beat.
  for (const [key, tok] of Object.entries(shown.tokens)) {
    const id = Number(key);
    const m = moving.get(id);
    // A printed value leaves the graph for the output strip under it.
    if (tok.at.node === "stdout") {
      if (m !== undefined && f < 1) {
        const start = fromSpots.get(id) ?? anchor(lay, m.from);
        draw(id, tok, along([start, [start[0], lay.height + 12]], e), Math.max(0, 1 - f), true, m.from);
      }
      continue;
    }
    const end = toSpots.get(id)!;
    if (m === undefined) {
      draw(id, tok, end, 1, false, tok.at);
      continue;
    }
    const start = m.born === true ? anchor(lay, m.from) : (fromSpots.get(id) ?? anchor(lay, m.from));
    const path: [number, number][] = [start];
    if (m.via !== undefined) path.push(centre(lay, m.via));
    path.push(end);
    const at = along(path, e);
    const opacity = m.born === true ? Math.min(1, f * 4) : 1;
    draw(id, tok, at, opacity, f > 0 && f < 1, f < 0.5 ? m.from : m.to);
  }
  // Tokens that leave the world in this beat fade where they were.
  if (beat?.kind === "batch") {
    for (const [key, tok] of Object.entries(from.tokens)) {
      const id = Number(key);
      if (shown.tokens[id] !== undefined) continue;
      const at = fromSpots.get(id) ?? anchor(lay, tok.at);
      draw(id, tok, at, Math.max(0, 1 - f * 1.6), false, tok.at);
    }
  }
  return <g className="sim-tokens">{items}</g>;
}

function radiusAt(lay: Layout, loc: Loc): number {
  const member = lay.members[loc.node];
  if (member !== undefined) return 4;
  const slots = lay.slots[loc.node];
  if (slots !== undefined) {
    const slot = slots[0]!;
    return Math.min(lay.r, slot.w / 2 + 0.5);
  }
  return lay.r;
}

function TokenDot({ tok, x, y, r, opacity, flying }: { tok: TokenView; x: number; y: number; r: number; opacity: number; flying: boolean }) {
  const text = valueText(tok.v);
  const showText = r >= 7.5 && tok.glyph === undefined;
  return (
    <g className={`sim-tok tone-${tok.tone % 3}${tok.glyph !== undefined ? ` is-${tok.glyph}` : ""}${flying ? " is-flying" : ""}`} opacity={opacity}>
      <circle cx={x} cy={y} r={r} />
      {showText && (
        <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="central" style={{ fontSize: `${text.length > 2 ? r * 0.9 : r * 1.08}px` }}>
          {text}
        </text>
      )}
      {tok.glyph === "key" && r >= 7 && <path className="sim-glyph" d={keyPath(x, y, r)} />}
      {tok.glyph === "tick" && r >= 7 && <path className="sim-glyph" d={tickPath(x, y, r)} />}
    </g>
  );
}

function keyPath(x: number, y: number, r: number): string {
  const s = r / 10;
  return `M${x - 5 * s},${y} a${2.6 * s},${2.6 * s} 0 1 0 ${0.01},0 M${x - 2.4 * s},${y} h${7.4 * s} v${2.4 * s} M${x + 3 * s},${y} v${1.8 * s}`;
}

function tickPath(x: number, y: number, r: number): string {
  const s = r / 10;
  return `M${x},${y - 4.5 * s} v${4.5 * s} l${3.2 * s},${2 * s}`;
}

// A method call on a named object, "forwarders.Wait()", drops the object
// when it would not fit: the edge from that object already names it.
function compact(text: string, width: number, size: number): string {
  if (text.length * size * 0.8 * 0.61 <= width) return text;
  const call = /^[^\s<]+\.(\w+\(\))$/.exec(text);
  return call === null ? text : call[1]!;
}

// A label that fits: shrink the type a little first, and clip with an
// ellipsis only as a last resort (the shots check fails on one).
function fitText(text: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (size * 0.8 * 0.61)));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function fitSize(text: string, width: number, size: number): number {
  const need = text.length * size * 0.61;
  return need <= width ? size : Math.max(size * 0.8, width / (text.length * 0.61));
}

export { labelRoom };
export type { NodeDef };
