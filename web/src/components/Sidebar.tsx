import { useMemo, useState } from "react";
import { site } from "../data.ts";
import { onLinkClick } from "../router.ts";
import type { Status } from "../storage.ts";
import { CheckIcon } from "./icons.tsx";

interface Props {
  current?: string;
  statuses: Record<string, Status | null>;
  open: boolean;
  onClose: () => void;
}

// LEVELS is how many boxes the difficulty bar draws. Warm-up keeps a single
// hollow box, so the scale has to start easy at two for the two to be told
// apart by length as well as by fill.
const LEVELS: Record<string, number> = { "warm-up": 1, easy: 2, medium: 3, hard: 4, extreme: 5 };

export function Sidebar({ current, statuses, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return site.exercises;
    return site.exercises.filter((e) =>
      [e.number, e.id, e.title, e.difficulty, ...(e.topics ?? [])].some((s) => s.toLowerCase().includes(q)),
    );
  }, [query]);
  const passed = site.exercises.filter((e) => statuses[e.id] === "passed").length;

  return (
    <nav id="exercise-nav" className={`sidebar${open ? " open" : ""}`} aria-label="Exercises">
      <div className="sidebar-search">
        <input
          type="search"
          placeholder="Filter by title, topic, difficulty"
          aria-label="Filter exercises"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ol className="ex-list">
        {items.map((e) => (
          <li key={e.id}>
            <a
              href={`/${e.id}`}
              className={e.id === current ? "active" : undefined}
              aria-current={e.id === current ? "page" : undefined}
              title={`${e.title}\n${e.difficulty} · ${(e.topics ?? []).join(", ")}`}
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
              {statuses[e.id] === "passed" && (
                <span className="ex-status pass" aria-label="passed">
                  <CheckIcon width={13} height={13} />
                </span>
              )}
            </a>
          </li>
        ))}
        {items.length === 0 && <li className="ex-empty">No exercise matches “{query}”.</li>}
      </ol>
      <div className="sidebar-foot">
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${(passed / site.exercises.length) * 100}%` }} />
        </div>
        {passed} of {site.exercises.length} passed in this browser
      </div>
    </nav>
  );
}
