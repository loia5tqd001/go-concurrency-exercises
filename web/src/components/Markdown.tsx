import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { linesFromAttr, renderMarkdown, wrapCodeLines, type DocContext } from "../markdown.ts";
import { monaco } from "../monaco.ts";
import { navigate } from "../router.ts";
import { onThemeChange } from "../theme.ts";
import type { SceneDef, VizSpec } from "../viz/engine/model.ts";
import { GOAL_IN_PROBLEM, VizDoor } from "../viz/VizDoor.tsx";
import { Player } from "../viz/view/Player.tsx";

interface Props {
  src: string;
  ctx: DocContext;
  onOpenFile?: (name: string) => void;
  // A spec turns the exercise README's pinned plain fences into doors. Other
  // Markdown mounts (the root README, solution docs) pass nothing.
  spec?: VizSpec | null;
}

interface DoorSlot {
  hash: string;
  pre: HTMLElement;
  node: HTMLElement;
  scenes: SceneDef[];
}

interface DoorLayout {
  slots: DoorSlot[];
  stale: SceneDef[];
  missing: string[];
}

const NO_DOORS: DoorLayout = { slots: [], stale: [], missing: [] };

type ProblemTier = "today" | "goal";

// The clipboard API needs a secure context. The fallback keeps a file://
// preview and an older browser working, where writeText rejects or is absent.
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function Markdown({ src, ctx, onOpenFile, spec = null }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // One object per html string: React sets innerHTML again whenever this
  // prop's identity changes, which would wipe the colorized code blocks on
  // every unrelated re-render.
  const inner = useMemo(() => ({ __html: renderMarkdown(src, ctx) }), [src, ctx.dir, ctx.exerciseId]);
  const html = inner.__html;

  // The door mounts after the rendered HTML exists, on the fence whose stamp
  // equals its pin. A pin with no fence is stale: development shows the scene
  // below the README with a strip, and a production build omits it (review
  // section 2.6).
  const [doors, setDoors] = useState<DoorLayout>(NO_DOORS);
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null || spec === null) {
      setDoors(NO_DOORS);
      return undefined;
    }

    const groups = new Map<string, { scenes: SceneDef[]; tiers: ProblemTier[] }>();
    const stale: SceneDef[] = [];
    const missing: string[] = [];
    const addTier = (tier: ProblemTier): void => {
      const scenes = spec.scenes.filter((scene) => scene.tier === tier);
      if (scenes.length === 0) return;
      const pin = spec.diagrams[tier];
      if (pin === undefined) {
        stale.push(...scenes);
        missing.push(`diagrams.${tier} is missing`);
        return;
      }
      // One fence may draw both states (04, 31), so equal pins share a door
      // with two chips. Two fences (18) give one door each.
      const group = groups.get(pin) ?? { scenes: [], tiers: [] };
      group.scenes.push(...scenes);
      group.tiers.push(tier);
      groups.set(pin, group);
    };
    addTier("today");
    if (GOAL_IN_PROBLEM) addTier("goal");

    const mounted: HTMLElement[] = [];
    const slots: DoorSlot[] = [];
    for (const [hash, group] of groups) {
      const pre = root.querySelector<HTMLElement>(`pre.md-code[data-diagram="${hash}"]`);
      if (pre === null) {
        stale.push(...group.scenes);
        missing.push(`diagrams.${group.tiers.join(" and ")} = ${hash} matches no plain fence`);
        continue;
      }
      // The chip bar is the top of the door in both views, so the door node
      // goes before the fence. The fence follows the bar in Diagram view and
      // is hidden in scene view (decision 51).
      const node = document.createElement("div");
      node.className = "viz-door-mount";
      pre.before(node);
      mounted.push(node);
      slots.push({ hash, pre, node, scenes: group.scenes });
    }

    setDoors({ slots, stale, missing });
    return () => {
      for (const node of mounted) node.remove();
    };
  }, [html, spec]);

  useEffect(() => {
    // Highlight Go blocks with the editor's own tokenizer, so code in the
    // docs looks exactly like code in the editor. The output's classes
    // belong to the current theme, so it is redone on every theme change.
    let live = true;
    // The copy button reads the fence as written, before colorize or banding
    // rewrites the markup.
    for (const code of ref.current?.querySelectorAll<HTMLElement>("pre.md-code > code") ?? []) {
      code.dataset.src ??= code.textContent ?? "";
    }
    // A fence that names lines is rebuilt as one block per line, so the named
    // lines can be banded. For Go that has to happen after colorize, which
    // replaces the whole markup.
    const paint = (code: HTMLElement, html: string) => {
      const hl = linesFromAttr(code.dataset.hl);
      code.innerHTML = hl.size ? wrapCodeLines(html, hl) : html;
    };
    const colorize = () => {
      for (const code of ref.current?.querySelectorAll<HTMLElement>('code[data-lang="go"]') ?? []) {
        monaco.editor.colorize(code.dataset.src ?? "", "go", { tabSize: 4 }).then((out) => {
          if (live) paint(code, out);
        });
      }
    };
    // Other languages are not colorized, so their markup is already final.
    for (const code of ref.current?.querySelectorAll<HTMLElement>('code[data-hl]:not([data-lang="go"])') ?? []) {
      paint(code, code.innerHTML);
    }
    colorize();
    const unsubscribe = onThemeChange(colorize);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [html]);

  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // The button lives in the rendered HTML, not in React state, so its label
  // is swapped in place and put back after a moment.
  const copyBlock = async (button: HTMLButtonElement): Promise<void> => {
    const text = button.parentElement?.querySelector("code")?.dataset.src ?? "";
    if (text === "") return;
    const ok = await writeClipboard(text);
    window.clearTimeout(copyTimer.current);
    button.textContent = ok ? "Copied" : "Copy failed";
    button.classList.toggle("is-copied", ok);
    copyTimer.current = window.setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("is-copied");
    }, 1400);
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const copyButton = target.closest<HTMLButtonElement>("button.md-copy");
    if (copyButton) {
      void copyBlock(copyButton);
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    if (a.hasAttribute("data-route")) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(a.getAttribute("href")!);
    } else if (a.dataset.file) {
      e.preventDefault();
      onOpenFile?.(a.dataset.file);
    }
  };

  return (
    <>
      <div ref={ref} className="markdown" onClick={onClick} dangerouslySetInnerHTML={inner} />
      {spec !== null &&
        doors.slots.map((slot) =>
          createPortal(<VizDoor spec={spec} scenes={slot.scenes} pre={slot.pre} />, slot.node, slot.hash),
        )}
      {/* Fail closed in production: a stale Problem scene is not shown at all.
          A development build shows it below the README with the strip that
          says why, so the owner can re-check and re-pin it. */}
      {import.meta.env.DEV && spec !== null && doors.stale.length > 0 && (
        <div className="viz-stale">
          <p className="viz-stale-strip" role="status">
            <strong>This scene was written for an older diagram.</strong> Re-check it, then run{" "}
            <code>npm run viz -- pin {ctx.exerciseId ?? ""}</code>. {doors.missing.join("; ")}.
          </p>
          <Player spec={spec} scenes={doors.stale} />
        </div>
      )}
    </>
  );
}
