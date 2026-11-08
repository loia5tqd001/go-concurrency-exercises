import { useEffect, useRef, useState } from "react";
import { site, type Exercise, type ExerciseSummary } from "../data.ts";
import { onLinkClick } from "../router.ts";
import type { Status } from "../storage.ts";
import type { VizSpec } from "../viz/engine/model.ts";
import { VizSolution } from "../viz/VizDoor.tsx";
import { DocTabs } from "./DocTabs.tsx";
import { Markdown } from "./Markdown.tsx";

interface Props {
  summary: ExerciseSummary;
  exercise: Exercise;
  tab: "problem" | "solution";
  status: Status | null;
  spec: VizSpec | null;
  onOpenFile: (name: string) => void;
}

export function DocPane({ summary, exercise, tab, status, spec, onOpenFile }: Props) {
  const [revealed, setRevealed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = summary.id;
  const files = exercise.files.map((f) => f.name);
  const index = site.exercises.findIndex((e) => e.id === id);
  const prev = site.exercises[index - 1];
  const next = site.exercises[index + 1];

  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [id, tab]);

  return (
    <section className="doc-pane" aria-label="Exercise">
      <DocTabs summary={summary} tab={tab} status={status} />

      <div className="doc-body" ref={bodyRef}>
        {summary.topics && summary.topics.length > 0 && (
          <div className="topics">
            {summary.topics.map((t) => (
              <span key={t} className="topic">
                {t}
              </span>
            ))}
          </div>
        )}

        {tab === "problem" ? (
          <Markdown
            src={exercise.readme}
            ctx={{ dir: `/${id}/`, exerciseId: id, files }}
            onOpenFile={onOpenFile}
            spec={spec}
          />
        ) : !exercise.solution ? (
          <p className="muted">There is no write-up for this exercise yet.</p>
        ) : revealed ? (
          <>
            <VizSolution spec={spec} />
            <Markdown src={exercise.solution} ctx={{ dir: "/solutions/", exerciseId: id, files }} onOpenFile={onOpenFile} />
          </>
        ) : (
          <div className="spoiler">
            <p>
              <strong>Spoiler.</strong> This is the full solution for exercise {summary.number}. Try the exercise first. Come back if
              you get stuck.
            </p>
            <button className="btn primary" onClick={() => setRevealed(true)}>
              Show the solution
            </button>
          </div>
        )}

        <nav className="pager" aria-label="Other exercises">
          {prev ? (
            <a href={`/${prev.id}`} onClick={onLinkClick}>
              <span className="muted">← {prev.number}</span> {prev.title}
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a href={`/${next.id}`} onClick={onLinkClick} className="next">
              {next.title} <span className="muted">{next.number} →</span>
            </a>
          )}
        </nav>
      </div>
    </section>
  );
}
