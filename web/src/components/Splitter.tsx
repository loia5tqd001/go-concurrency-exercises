import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { loadPref, savePref } from "../storage.ts";

interface Props {
  axis: "x" | "y";
  // target is the grid container whose CSS variable this splitter drives.
  target: RefObject<HTMLElement | null>;
  cssVar: string;
  prefKey: string;
  min?: number;
  max?: number;
}

// paneFraction reads a saved splitter position, or fallback if there is none.
export function paneFraction(prefKey: string, fallback: number): number {
  const raw = loadPref(prefKey);
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

// Splitter resizes two panes by setting a fraction on the container as a CSS
// variable; dragging never re-renders React.
export function Splitter({ axis, target, cssVar, prefKey, min = 0.2, max = 0.8 }: Props) {
  const frac = useRef<number | null>(null);

  const set = (f: number) => {
    const clamped = Math.min(max, Math.max(min, f));
    frac.current = clamped;
    target.current?.style.setProperty(cssVar, `${(clamped * 100).toFixed(2)}%`);
  };
  const current = () => {
    const el = target.current;
    if (!el) return 0.5;
    const v = parseFloat(el.style.getPropertyValue(cssVar));
    return Number.isFinite(v) ? v / 100 : 0.5;
  };
  const persist = () => {
    if (frac.current !== null) savePref(prefKey, frac.current.toFixed(4));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !target.current) return;
    const r = target.current.getBoundingClientRect();
    set(axis === "x" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-x", "resizing-y");
    persist();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -0.02, ArrowUp: -0.02, ArrowRight: 0.02, ArrowDown: 0.02 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    set(current() + step);
    persist();
  };

  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
