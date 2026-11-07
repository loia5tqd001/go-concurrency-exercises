// The code beside the graph. Each line a goroutine sits on carries a dot in
// the gutter, so "blocked on out <-" points at the very line. Focusing a node
// on the graph lights the lines that node runs.

import { useMemo, type ReactNode } from "react";
import type { CodeLine } from "../engine/sim.ts";
import { goName, nodeOf } from "../engine/sim.ts";
import type { GView, Model, World } from "../engine/model.ts";

interface Props {
  model: Model;
  lines: CodeLine[];
  world: World;
  focus: string | null;
  onFocus: (id: string | null, pin: boolean) => void;
}

export function CodePanel({ model, lines, world, focus, onFocus }: Props) {
  // The player re-renders every frame; highlighting the same text each time
  // would cost the page for nothing.
  const marked = useMemo(() => lines.map((line) => highlight(line.text)), [lines]);
  const at = new Map<number, { key: string; view: GView }[]>();
  for (const [key, view] of Object.entries(world.g)) {
    if (view.line === undefined) continue;
    if (view.status === "idle" || view.status === "done") continue;
    at.set(view.line, [...(at.get(view.line) ?? []), { key, view }]);
  }
  const file = model.code?.file === "solution" ? "solution" : (model.code?.file ?? "");

  return (
    <details className="sim-code" open>
      <summary>
        <span className="sim-code-file">{file}</span>
        <span className="sim-code-hint">The dot shows where each goroutine is.</span>
      </summary>
      <pre className="sim-code-body">
        {lines.map((line, n) => {
          const here = at.get(n) ?? [];
          const owned = focus !== null && line.owners.includes(focus);
          const current = focus !== null && here.some(({ key }) => nodeOf(key) === focus);
          const owner = line.owners[0];
          return (
            <div
              key={n}
              className={`sim-line${owned ? " is-owned" : ""}${current ? " is-current" : ""}${line.gap ? " is-gap" : ""}`}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse" && owner !== undefined) onFocus(owner, false);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") onFocus(null, false);
              }}
            >
              <span className="sim-gutter" aria-hidden={here.length === 0}>
                {here.length > 0 && <Marker model={model} here={here} />}
              </span>
              <code>{marked[n]}</code>
            </div>
          );
        })}
      </pre>
    </details>
  );
}

function Marker({ model, here }: { model: Model; here: { key: string; view: GView }[] }) {
  const worst = here.some(({ view }) => view.status === "leaked" || view.status === "deadlocked" || view.status === "panicked")
    ? "is-bad"
    : here.some(({ view }) => view.status === "blocked")
      ? "is-wait"
      : "is-run";
  const names = here.map(({ key }) => goName(model, key));
  const title = names.length > 3 ? `${names.length} goroutines` : names.join(", ");
  return (
    <span className={`sim-marker ${worst}`} title={title}>
      <span className="sim-marker-dot" />
      {here.length > 1 && <span className="sim-marker-n">{here.length}</span>}
      <span className="sr-only">{title} here</span>
    </span>
  );
}

const GO = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|`[^`]*`)|(<-)|\b(func|go|defer|for|range|select|case|default|return|if|else|var|const|type|struct|chan|map|break|continue|package|import|nil|true|false)\b|\b(make|close|len|cap|append|new|panic)\b|\b(\d+)\b/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  GO.lastIndex = 0;
  let n = 0;
  while ((match = GO.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const cls = match[1] ? "c" : match[2] ? "s" : match[3] ? "op" : match[4] ? (["go", "chan", "select"].includes(token) ? "kc" : "k") : match[5] ? "b" : "n";
    out.push(
      <span key={n++} className={`hl-${cls}`}>
        {token}
      </span>,
    );
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  if (out.length === 0) out.push(" ");
  return out;
}
