import type { ExerciseSummary } from "../data.ts";
import { onLinkClick, routePath } from "../router.ts";
import type { Status } from "../storage.ts";
import { hasViz } from "../viz/registry.ts";
import { CheckIcon, VisualisationIcon } from "./icons.tsx";

interface Props {
  summary: ExerciseSummary;
  tab: "problem" | "solution";
  status: Status | null;
}

// The Problem/Solution row reads only the summary, the route and the saved
// status, so it needs no fetch. The loading skeleton renders this same
// component. A second copy of the row would drift from `.doc-tabs` and move
// the tabs when the exercise finishes loading.
export function DocTabs({ summary, tab, status }: Props) {
  const id = summary.id;
  return (
    <nav className="doc-tabs" aria-label="Exercise content">
      <a aria-current={tab === "problem" ? "page" : undefined} href={routePath({ id, tab: "problem" })} onClick={onLinkClick}>
        Problem
      </a>
      <a aria-current={tab === "solution" ? "page" : undefined} href={routePath({ id, tab: "solution" })} onClick={onLinkClick}>
        Solution
      </a>
      <span className="spacer" />
      {summary.unsupported && (
        <span className="badge local" title="Tests need Go on your computer">
          local
        </span>
      )}
      {hasViz(id) && (
        <span className="badge visualisation" title="This exercise has an animation">
          <VisualisationIcon width={11} height={11} /> visual
        </span>
      )}
      <span className={`badge diff-${summary.difficulty}`}>{summary.difficulty}</span>
      {status === "passed" && (
        <span className="badge pass">
          <CheckIcon width={11} height={11} /> passed
        </span>
      )}
    </nav>
  );
}
