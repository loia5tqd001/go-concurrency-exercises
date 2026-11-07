import { useState } from "react";
import { site, type Exercise, type ExerciseSummary } from "../data.ts";
import { onLinkClick, routePath } from "../router.ts";
import type { Status } from "../storage.ts";
import { VizSolution } from "../viz/VizDoor.tsx";
import { useVizSpec } from "../viz/useVizSpec.ts";
import { CheckIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

interface Props {
  summary: ExerciseSummary;
  exercise: Exercise;
  tab: "problem" | "solution";
  status: Status | null;
  onOpenFile: (name: string) => void;
}

export function DocPane({ summary, exercise, tab, status, onOpenFile }: Props) {
  const [revealed, setRevealed] = useState(false);
  const id = summary.id;
  const spec = useVizSpec(id);
  const files = exercise.files.map((f) => f.name);
  const index = site.exercises.findIndex((e) => e.id === id);
  const prev = site.exercises[index - 1];
  const next = site.exercises[index + 1];

  return (
    <section className="doc-pane" aria-label="Exercise">
      <div className="doc-tabs" role="tablist">
        <a role="tab" aria-selected={tab === "problem"} href={routePath({ id, tab: "problem" })} onClick={onLinkClick}>
          Problem
        </a>
        <a role="tab" aria-selected={tab === "solution"} href={routePath({ id, tab: "solution" })} onClick={onLinkClick}>
          Solution
        </a>
        <span className="spacer" />
        <span className={`badge diff-${summary.difficulty}`}>{summary.difficulty}</span>
        {status === "passed" && (
          <span className="badge pass">
            <CheckIcon width={11} height={11} /> passed
          </span>
        )}
      </div>

      <div className="doc-body">
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
              <strong>Spoiler.</strong> This is the worked solution for exercise {summary.number}, with the reasoning behind it. Try the
              exercise first, and come back when you are stuck or want to compare notes.
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
