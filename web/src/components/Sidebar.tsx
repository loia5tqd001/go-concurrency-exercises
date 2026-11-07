import { useEffect, useMemo, useRef, useState } from "react";
import { site } from "../data.ts";
import { defaultScope, isRecommended, recommendedExercises, type ExerciseScope } from "../recommended.ts";
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
  const [scope, setScope] = useState<ExerciseScope>(() => defaultScope(current));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const searching = query.trim() !== "";
  const items = useMemo(() => {
    // Search spans the full catalogue. A query should never miss an exercise
    // merely because it falls outside the short recommended path.
    const available = searching || scope === "all" ? site.exercises : recommendedExercises(site.exercises);
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
  }, [query, scope, searching]);
  const passed = site.exercises.filter((e) => statuses[e.id] === "passed").length;

  useEffect(() => {
    if (current !== undefined && !isRecommended(current)) setScope("all");
  }, [current]);

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
          <legend className="sr-only">Exercise list</legend>
          <label>
            <input type="radio" name="exercise-scope" checked={scope === "recommended"} onChange={() => setScope("recommended")} />
            <span>Recommended</span>
          </label>
          <label>
            <input type="radio" name="exercise-scope" checked={scope === "all"} onChange={() => setScope("all")} />
            <span>All exercises</span>
          </label>
        </fieldset>
      </div>
      <div className="sidebar-match-count">
        {searching
          ? `${items.length} ${items.length === 1 ? "match" : "matches"} across all exercises`
          : scope === "recommended"
            ? `${items.length} recommended`
            : `${items.length} exercises`}
      </div>
      <ol className="ex-list" id="exercise-list" ref={listRef}>
        {items.map((e) => (
          <li key={e.id}>
            <a
              href={`/${e.id}`}
              className={e.id === current ? "active" : undefined}
              aria-current={e.id === current ? "page" : undefined}
              title={`${e.title}\n${e.difficulty} · ${(e.topics ?? []).join(", ")}${statuses[e.id] ? `\n${statuses[e.id]}` : ""}${hasViz(e.id) ? "\nHas an animation" : ""}${e.unsupported ? "\nTests need Go on your computer" : ""}`}
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
                  <span className="ex-local" title="Tests need Go on your computer">
                    local
                  </span>
                )}
                {hasViz(e.id) && (
                  <span className="ex-viz" role="img" aria-label="has an animation">
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
        {items.length === 0 && <li className="ex-empty">No exercise matches these filters.</li>}
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
        {searching
          ? `${items.length} exercises match across all exercises`
          : scope === "recommended"
            ? `${items.length} recommended exercises shown`
            : `All ${site.exercises.length} exercises shown`}
      </span>
    </nav>
  );
}
