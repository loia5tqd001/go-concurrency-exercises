import { useEffect, useMemo, useRef, useState } from "react";
import { site } from "../data.ts";
import { onLinkClick } from "../router.ts";
import type { Status } from "../storage.ts";
import { hasViz } from "../viz/registry.ts";
import { CheckIcon, CrossIcon, VisualisationIcon } from "./icons.tsx";

interface Props {
  current?: string;
  statuses: Record<string, Status | null>;
  open: boolean;
  modal: boolean;
  onClose: () => void;
}

// LEVELS is how many boxes the difficulty bar draws. Warm-up keeps a single
// hollow box, so the scale has to start easy at two for the two to be told
// apart by length as well as by fill.
const LEVELS: Record<string, number> = { "warm-up": 1, easy: 2, medium: 3, hard: 4, extreme: 5 };

export function Sidebar({ current, statuses, open, modal, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [browserOnly, setBrowserOnly] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const items = useMemo(() => {
    const available = browserOnly ? site.exercises.filter((exercise) => !exercise.unsupported) : site.exercises;
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((e) =>
      // Typing "visual" lists the exercises that have an animation.
      [
        e.number,
        e.id,
        e.title,
        e.difficulty,
        ...(e.topics ?? []),
        ...(hasViz(e.id) ? ["visualisation", "animation", "visual"] : []),
        ...(e.unsupported ? ["local", "browser unsupported"] : ["browser runnable"]),
      ].some((s) => s.toLowerCase().includes(q)),
    );
  }, [browserOnly, query]);
  const passed = site.exercises.filter((e) => statuses[e.id] === "passed").length;
  const filtered = query.trim() !== "" || browserOnly;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <nav
      id="exercise-nav"
      className={`sidebar${open ? " open" : ""}`}
      aria-label="Exercises"
      aria-hidden={modal && !open ? true : undefined}
      inert={(modal && !open) || undefined}
    >
      <div className="sidebar-search">
        <input
          ref={inputRef}
          type="search"
          placeholder="Filter by title, topic, difficulty"
          aria-label="Filter exercises"
          aria-controls="exercise-list"
          aria-describedby="exercise-results"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <fieldset className="sidebar-filter">
          <legend className="sr-only">Exercise availability</legend>
          <label>
            <input type="radio" name="exercise-availability" checked={!browserOnly} onChange={() => setBrowserOnly(false)} />
            <span>All</span>
          </label>
          <label>
            <input type="radio" name="exercise-availability" checked={browserOnly} onChange={() => setBrowserOnly(true)} />
            <span>Browser only</span>
          </label>
        </fieldset>
      </div>
      {filtered && (
        <div className="sidebar-match-count">
          {query.trim() !== ""
            ? `${items.length} ${items.length === 1 ? "match" : "matches"}`
            : `${items.length} browser-runnable`}
        </div>
      )}
      <ol className="ex-list" id="exercise-list" ref={listRef}>
        {items.map((e) => (
          <li key={e.id}>
            <a
              href={`/${e.id}`}
              className={e.id === current ? "active" : undefined}
              aria-current={e.id === current ? "page" : undefined}
              title={`${e.title}\n${e.difficulty} · ${(e.topics ?? []).join(", ")}${statuses[e.id] ? `\n${statuses[e.id]}` : ""}${hasViz(e.id) ? "\nHas an animated visualisation" : ""}${e.unsupported ? "\nTests require local Go" : ""}`}
              onClick={(ev) => {
                onLinkClick(ev);
                onClose();
              }}
            >
              <span className="ex-num">
                {e.number}
                <span className={`diff-bar diff-${e.difficulty}`} aria-label={e.difficulty}>
                  {Array.from({ length: LEVELS[e.difficulty] ?? 1 }, (_, i) => (
                    <i key={i} />
                  ))}
                </span>
              </span>
              <span className="ex-title">{e.title}</span>
              <span className="ex-marks">
                {e.unsupported && (
                  <span className="ex-local" title="Tests require local Go">
                    local
                  </span>
                )}
                {hasViz(e.id) && (
                  <span className="ex-viz" role="img" aria-label="has an animated visualisation">
                    <VisualisationIcon width={14} height={14} />
                  </span>
                )}
                {statuses[e.id] === "passed" && (
                  <span className="ex-status pass" aria-label="passed">
                    <CheckIcon width={13} height={13} />
                  </span>
                )}
                {statuses[e.id] === "failed" && (
                  <span className="ex-status fail" aria-label="tests failed">
                    <CrossIcon width={13} height={13} />
                  </span>
                )}
              </span>
            </a>
          </li>
        ))}
        {items.length === 0 && <li className="ex-empty">No exercise matches the current filters.</li>}
      </ol>
      <div className="sidebar-foot">
        <progress
          className="progress"
          max={site.exercises.length}
          value={passed}
          aria-label={`${passed} of ${site.exercises.length} exercises passed in this browser`}
        />
        <span>
          {passed} of {site.exercises.length} passed in this browser
        </span>
      </div>
      <span id="exercise-results" className="sr-only" aria-live="polite">
        {browserOnly
          ? `${items.length} browser-runnable exercises shown`
          : query.trim() !== ""
            ? `${items.length} exercises match`
            : `All ${site.exercises.length} exercises shown`}
      </span>
    </nav>
  );
}
