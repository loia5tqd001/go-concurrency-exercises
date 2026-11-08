// Layout. A spec places nodes on a coarse grid (column, row), with data
// flowing left to right. This file turns the grid into pixels for the width
// the figure has. When columns would be too narrow, it turns the grid so data
// flows top to bottom: a column becomes a band and a row becomes a lane.

import type { Edge, EdgeType, Loc, Model, NodeDef } from "./model.ts";
import { memberKeys } from "./sim.ts";

export interface Box {
  // Centre and size.
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeBox extends Box {
  id: string;
  def: NodeDef;
}

export interface EdgePath {
  from: string;
  to: string;
  type: EdgeType;
  points: [number, number][];
  label?: string;
}

export interface Layout {
  // The width the layout was computed for. When the graph needs more room
  // than the figure has, the view draws it scaled: shown width = width × scale.
  width: number;
  height: number;
  scale: number;
  portrait: boolean;
  nodes: Record<string, NodeBox>;
  edges: EdgePath[];
  // Channel slots and slice cells, by node id.
  slots: Record<string, Box[]>;
  // Group member cells, by member key (worker[3]).
  members: Record<string, Box>;
  // Token radius on goroutines and channel slots.
  r: number;
}

const PAD = 14;
const LABEL_ABOVE = 16;
// Landscape: one grid row is this tall. Portrait: one grid column is.
const ROW_H = 86;
const BAND_H = 104;
// A column narrower than this turns the grid.
const MIN_COL = 116;
const ROUTE_GAP = 22;

const CHAR = 7.3;

// The layout for a figure `width` wide. A graph too dense for that width is
// laid out wider and drawn scaled down, so nodes and names never overlap; the
// player's large view shows it at full size.
export function layout(model: Model, edges: readonly Edge[], width: number): Layout {
  let lay = layoutAt(model, edges, width);
  // The orientation is decided at the real width. A wider retry that flipped
  // to landscape would draw a different picture, not a scaled one.
  const portrait = lay.portrait;
  for (let k = 1; k <= 40 && collisions(lay).length > 0; k++) {
    const wider = Math.round(width * (1 + 0.05 * k));
    lay = { ...layoutAt(model, edges, wider, portrait), scale: width / wider };
  }
  return lay;
}

// Pairs of nodes, or of names above nodes, that overlap.
export function collisions(lay: Layout): [string, string][] {
  const rects: { id: string; x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const b of Object.values(lay.nodes)) {
    rects.push({ id: b.id, x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y - b.h / 2, y1: b.y + b.h / 2 });
    if (labelRoom(b.def, lay.portrait) > 0) {
      const text = b.def.label + (b.def.kind === "channel" && b.def.cap > 0 ? `  cap ${b.def.cap}` : b.def.kind === "slice" ? `  ${b.def.size}/${b.def.size}` : "");
      const w = text.length * 7.3;
      rects.push({ id: `${b.id} name`, x0: b.x - w / 2, x1: b.x + w / 2, y0: b.y - b.h / 2 - LABEL_ABOVE, y1: b.y - b.h / 2 - 2 });
    }
  }
  const out: [string, string][] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.id.split(" ")[0] === b.id.split(" ")[0]) continue;
      if (a.x0 < b.x1 - 1 && b.x0 < a.x1 - 1 && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1) out.push([a.id, b.id]);
    }
  }
  for (const b of Object.values(lay.nodes)) {
    if (b.x - b.w / 2 < 0 || b.x + b.w / 2 > lay.width) out.push([b.id, "edge"]);
  }
  return out;
}

function layoutAt(model: Model, edges: readonly Edge[], width: number, portrait?: boolean): Layout {
  // A sender that also closes needs no second line: the channel says closed.
  const kept = edges.filter(
    (edge) => !(edge.type === "close" && edges.some((other) => other.type === "data" && other.from === edge.from && other.to === edge.to)),
  );
  const first = place(model, kept, width, model.routes ?? {}, portrait);
  // An edge that would cross a node bends around the graph instead.
  const auto: Record<string, "below" | "above"> = { ...(model.routes ?? {}) };
  let bent = false;
  const mid = first.portrait
    ? (Math.min(...Object.values(first.nodes).map((b) => b.x)) + Math.max(...Object.values(first.nodes).map((b) => b.x))) / 2
    : (Math.min(...Object.values(first.nodes).map((b) => b.y)) + Math.max(...Object.values(first.nodes).map((b) => b.y))) / 2;
  for (const path of first.edges) {
    const key = `${path.from}>${path.to}`;
    if (auto[key] !== undefined || path.points.length !== 2) continue;
    if (!crosses(path, first.nodes, first.portrait)) continue;
    const a = first.nodes[path.from]!;
    const b = first.nodes[path.to]!;
    const across = first.portrait ? (a.x + b.x) / 2 : (a.y + b.y) / 2;
    auto[key] = across <= mid ? "above" : "below";
    bent = true;
  }
  return bent ? place(model, kept, width, auto, portrait) : first;
}

function span(path: EdgePath): number {
  const xs = path.points.map((p) => p[0]);
  const ys = path.points.map((p) => p[1]);
  return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
}

// Does a straight edge pass through a node other than its two ends?
function crosses(path: EdgePath, nodes: Record<string, NodeBox>, portrait: boolean): boolean {
  const [a, b] = path.points as [[number, number], [number, number]];
  for (const node of Object.values(nodes)) {
    if (node.id === path.from || node.id === path.to) continue;
    const top = node.y - node.h / 2 - labelRoom(node.def, portrait) - 3;
    const bottom = node.y + node.h / 2 + 3;
    const left = node.x - node.w / 2 - 3;
    const right = node.x + node.w / 2 + 3;
    for (let k = 1; k < 24; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / 24;
      const y = a[1] + ((b[1] - a[1]) * k) / 24;
      if (x > left && x < right && y > top && y < bottom) return true;
    }
  }
  return false;
}

function place(
  model: Model,
  edges: readonly Edge[],
  width: number,
  routes: Readonly<Record<string, "below" | "above">>,
  forcePortrait?: boolean,
): Layout {
  const entries = Object.entries(model.nodes);
  // A node at column c is centred c + 0.5 cells in, so the grid spans the
  // largest position plus one cell, fractions included.
  const cols = Math.max(1, ...entries.map(([, def]) => def.pos[0] + 1));
  const rows = Math.max(1, ...entries.map(([, def]) => def.pos[1] + 1));
  const hasBelow = Object.values(routes).includes("below");
  const hasAbove = Object.values(routes).includes("above");

  const inner = width - PAD * 2;
  const portrait = forcePortrait ?? (inner / cols < MIN_COL && cols > 1);

  // Along the flow: columns (landscape x, portrait y). Across: rows.
  const gutterA = hasAbove ? ROUTE_GAP : 0;
  const gutterB = hasBelow ? ROUTE_GAP : 0;
  let cellW: number;
  let cellH: number;
  if (!portrait) {
    cellW = inner / cols;
    cellH = ROW_H;
  } else {
    cellW = (inner - gutterA - gutterB) / rows;
    cellH = BAND_H;
  }
  const r = portrait ? 9.5 : 10.5;

  const nodes: Record<string, NodeBox> = {};
  const slots: Record<string, Box[]> = {};
  const members: Record<string, Box> = {};

  // The room a node has across the flow and along it.
  const room = portrait ? cellW : cellW;

  for (const [id, def] of entries) {
    const [col, row] = def.pos;
    let x: number;
    let y: number;
    if (!portrait) {
      x = PAD + (col + 0.5) * cellW;
      y = PAD + gutterA + LABEL_ABOVE + (row + 0.5) * cellH;
    } else {
      x = PAD + gutterA + (row + 0.5) * cellW;
      y = PAD + LABEL_ABOVE + (col + 0.5) * cellH;
    }
    const size = nodeSize(def, room, portrait);
    nodes[id] = { id, def, x, y, w: size.w, h: size.h };

    if (def.kind === "channel") {
      const n = Math.max(1, Math.min(def.cap, 8));
      const step = Math.min(portrait ? 22 : 26, (size.w - 12) / n);
      // In portrait the box has two lines: the name, then the slots.
      slots[id] = Array.from({ length: n }, (_, k) => ({
        x: x + (k - (n - 1) / 2) * step,
        y: portrait ? y + 9 : y,
        w: step - 4,
        h: step - 4,
      }));
    } else if (def.kind === "slice") {
      const n = def.size;
      const cell = sliceCell(def.size, size.w);
      const gap = cell >= 12 ? 3 : 2;
      const span = n * cell + (n - 1) * gap;
      slots[id] = Array.from({ length: n }, (_, k) => ({
        x: x - span / 2 + cell / 2 + k * (cell + gap),
        y,
        w: cell,
        h: cell,
      }));
    } else if (def.kind === "goroutine" && def.count !== undefined) {
      const keys = memberKeys(id, def);
      const grid = groupGrid(keys.length, size.w);
      const span = grid.perRow * grid.cell + (grid.perRow - 1) * grid.gap;
      const top = y - size.h / 2 + GROUP_HEAD;
      keys.forEach((key, k) => {
        const cx = x - span / 2 + grid.cell / 2 + (k % grid.perRow) * (grid.cell + grid.gap);
        const cy = top + grid.cell / 2 + Math.floor(k / grid.perRow) * (grid.cell + grid.gap);
        members[key] = { x: cx, y: cy, w: grid.cell, h: grid.cell };
      });
    }
  }

  // Trim the empty band above the first node, so the graph starts at the top.
  {
    const top = Math.min(...Object.values(nodes).map((b) => b.y - b.h / 2 - labelRoom(b.def, portrait)));
    const shift = top - (PAD + gutterA);
    if (shift > 0) {
      for (const b of Object.values(nodes)) b.y -= shift;
      for (const list of Object.values(slots)) for (const b of list) b.y -= shift;
      for (const b of Object.values(members)) b.y -= shift;
    }
  }
  const boxes = Object.values(nodes);
  const minTop = Math.min(...boxes.map((b) => b.y - b.h / 2 - labelRoom(b.def, portrait)));
  const maxBottom = Math.max(...boxes.map((b) => b.y + b.h / 2));
  const maxRight = Math.max(...boxes.map((b) => b.x + b.w / 2));
  const minLeft = Math.min(...boxes.map((b) => b.x - b.w / 2));

  const height = maxBottom + PAD + gutterB + (Object.values(nodes).some((b) => b.def.kind === "channel" && b.y + b.h / 2 === maxBottom) ? 14 : 0);

  const paths: EdgePath[] = [];
  for (const edge of edges) {
    const a = nodes[edge.from];
    const b = nodes[edge.to];
    if (a === undefined || b === undefined || a === b) continue;
    const route = routes[`${edge.from}>${edge.to}`];
    let points: [number, number][];
    if (route !== undefined) {
      if (!portrait) {
        const ry = route === "below" ? maxBottom + ROUTE_GAP * 0.7 : minTop - ROUTE_GAP * 0.5;
        const sy = route === "below" ? a.y + a.h / 2 : a.y - a.h / 2 - labelRoom(a.def, portrait);
        const ty = route === "below" ? b.y + b.h / 2 : b.y - b.h / 2 - labelRoom(b.def, portrait);
        points = [
          [a.x, sy],
          [a.x, ry],
          [b.x, ry],
          [b.x, ty + (route === "below" ? 3 : -3)],
        ];
      } else {
        const rx = route === "below" ? maxRight + ROUTE_GAP * 0.6 : minLeft - ROUTE_GAP * 0.6;
        const sx = route === "below" ? a.x + a.w / 2 : a.x - a.w / 2;
        const tx = route === "below" ? b.x + b.w / 2 : b.x - b.w / 2;
        points = [
          [sx, a.y],
          [rx, a.y],
          [rx, b.y],
          [tx + (route === "below" ? 3 : -3), b.y],
        ];
      }
    } else {
      points = [clip(a, [b.x, b.y]), clip(b, [a.x, a.y])];
    }
    paths.push({ ...edge, points, label: edge.label ?? edgeLabel(edge.type) });
  }

  // Routed edges share one gutter, so their labels would stack on one line.
  // Keep the label on the longest of each kind.
  const routed = paths.filter((path) => path.points.length > 2 && path.label !== undefined);
  for (const path of routed) {
    const longest = routed
      .filter((other) => other.label === path.label)
      .reduce((a, b) => (span(b) > span(a) ? b : a));
    if (longest !== path) path.label = undefined;
  }

  return { width, height: Math.ceil(height), scale: 1, portrait, nodes, edges: paths, slots, members, r };
}

function edgeLabel(type: EdgeType): string | undefined {
  switch (type) {
    case "close":
      return "close";
    case "spawn":
      return "go";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

// The width a channel's name takes inside its box in portrait.
export function channelNameWidth(label: string): number {
  return label.length * 7.3 + 8;
}

// Room above a node for its name: channels and slices print the name above.
// When data flows top to bottom, edges enter from above, so the name moves
// to the side and needs no room above.
export function labelRoom(def: NodeDef, portrait = false): number {
  return !portrait && (def.kind === "channel" || def.kind === "slice") ? LABEL_ABOVE : 0;
}

const GROUP_HEAD = 38;

function groupGrid(n: number, w: number): { perRow: number; cell: number; gap: number } {
  const cell = n > 16 ? 10 : 13;
  const gap = n > 16 ? 2 : 3;
  const most = Math.max(1, Math.min(n, Math.floor((w - 14 + gap) / (cell + gap))));
  // Balanced rows: ten members in two rows of five, not nine and one.
  const lines = Math.ceil(n / most);
  return { perRow: Math.ceil(n / lines), cell, gap };
}

function sliceCell(n: number, w: number): number {
  const gaps = Math.max(0, n - 1);
  const wide = (w - 12 - gaps * 3) / n;
  if (wide >= 12) return Math.min(22, wide);
  return Math.max(6, Math.min(22, (w - 12 - gaps * 2) / n));
}

function nodeSize(def: NodeDef, room: number, portrait: boolean): { w: number; h: number } {
  const fit = (want: number, min: number): number => Math.max(min, Math.min(want, room - 10));
  switch (def.kind) {
    case "goroutine": {
      if (def.count === undefined) return { w: fit(132, 72), h: 46 };
      const w = fit(portrait ? 150 : 168, 90);
      const grid = groupGrid(def.count, w);
      const lines = Math.ceil(def.count / grid.perRow);
      return { w, h: GROUP_HEAD + lines * (grid.cell + grid.gap) + 5 };
    }
    case "channel": {
      const n = Math.max(1, Math.min(def.cap, 8));
      // Data flows top to bottom in portrait, so edges enter from above and
      // leave below, and a name beside or above the box would meet them. The
      // box gets two lines: the name, then the slots.
      if (portrait) return { w: fit(Math.max(channelNameWidth(def.label), n * 22) + 12, 50), h: 46 };
      return { w: fit(Math.max(58, n * 26 + 14), 50), h: 30 };
    }
    case "slice": {
      const gaps = Math.max(0, def.size - 1);
      const minimum = def.size * 6 + gaps * 2 + 12;
      const want = def.size * 20 + gaps * 3 + 12;
      const w = Math.max(minimum, Math.min(want, room - 10));
      return { w, h: Math.max(22, sliceCell(def.size, w) + 10) };
    }
    case "waitgroup":
      return { w: fit(Math.max(78, (def.label.length + 3) * CHAR + 18), 64), h: 30 };
    case "mutex":
      return { w: fit(Math.max(74, def.label.length * CHAR + 44), 64), h: 30 };
    case "cond":
      return { w: fit(Math.max(92, def.label.length * CHAR + 54), 72), h: 30 };
    case "timer":
      return { w: fit(Math.max(110, def.label.length * CHAR + 70), 84), h: 34 };
    case "context":
      // Wide enough for "cancelled" or "100 ms left" under the name.
      return { w: fit(Math.max(96, def.label.length * CHAR + 50), 70), h: 34 };
    case "fact": {
      if (def.states !== undefined) {
        const pills = def.states.reduce((sum, s) => sum + s.length * 6.2 + 14, 0);
        return { w: fit(Math.max(pills + 12, def.label.length * CHAR + 20), 80), h: 44 };
      }
      // Room for "label value unit" and, with a limit, "  ≤ limit".
      const text = `${def.label} ${String(def.value)}${def.unit !== undefined ? ` ${def.unit}` : ""}${def.limit !== undefined ? `  ≤ ${def.limit}` : ""}`;
      return { w: fit(Math.max(96, text.length * CHAR + 26), 72), h: def.limit !== undefined ? 40 : 30 };
    }
  }
}

// Where a line from this box toward p leaves the box.
function clip(box: Box, p: [number, number]): [number, number] {
  const dx = p[0] - box.x;
  const dy = p[1] - box.y;
  if (dx === 0 && dy === 0) return [box.x, box.y];
  const s = Math.min(box.w / 2 / Math.abs(dx || 1e-9), (box.h / 2 + 3) / Math.abs(dy || 1e-9));
  return [box.x + dx * Math.min(1, s), box.y + dy * Math.min(1, s)];
}

// Where a token at loc is drawn. `k` is its place among the tokens a
// goroutine holds.
export function anchor(lay: Layout, loc: Loc, k = 0): [number, number] {
  const member = lay.members[loc.node];
  if (member !== undefined) return [member.x, member.y];
  const slots = lay.slots[loc.node];
  if (slots !== undefined) {
    const box = slots[Math.min(loc.slot ?? 0, slots.length - 1)]!;
    return [box.x, box.y];
  }
  if (loc.node === "stdout") return [lay.width / 2, lay.height + 6];
  const id = loc.node.includes("[") ? loc.node.slice(0, loc.node.indexOf("[")) : loc.node;
  const node = lay.nodes[id];
  if (node === undefined) return [lay.width / 2, lay.height / 2];
  switch (node.def.kind) {
    case "goroutine":
      return [node.x + node.w / 2 - 4 - k * (lay.r * 2 + 3), node.y - node.h / 2 + 2];
    case "mutex":
      return [node.x + node.w / 2 - 15, node.y];
    case "timer":
      return [node.x + node.w / 2 - 14, node.y - node.h / 2];
    default:
      return [node.x, node.y];
  }
}

// The point a token passes when it goes through a node without stopping.
export function centre(lay: Layout, id: string): [number, number] {
  const node = lay.nodes[id];
  return node === undefined ? [lay.width / 2, lay.height / 2] : [node.x, node.y];
}

// Text width estimates for SVG layout without measuring.
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.61;
}
