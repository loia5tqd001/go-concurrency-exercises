import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadExercise, type Exercise, type ExerciseSummary } from "../data.ts";
import type { Status } from "../storage.ts";
import { useVizSpec } from "../viz/useVizSpec.ts";
import { CodePane, type OpenFile } from "./CodePane.tsx";
import { DocPane } from "./DocPane.tsx";
import { paneFraction, Splitter } from "./Splitter.tsx";

interface Props {
  summary: ExerciseSummary;
  tab: "problem" | "solution";
  status: Status | null;
  onStatus: (status: Status | null) => void;
}

export function ExerciseView({ summary, tab, status, onStatus }: Props) {
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viz = useVizSpec(summary.id);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const openFile = useRef<OpenFile>(() => {});

  useEffect(() => {
    let live = true;
    loadExercise(summary).then(
      (e) => live && setExercise(e),
      (err) => live && setError(String(err)),
    );
    return () => {
      live = false;
    };
  }, [summary]);

  if (error) return <div className="placeholder">This exercise did not load: {error}</div>;
  // The README's visualisation chips are inserted by a layout effect. Keep
  // the whole workspace off screen until both requests settle, so a late
  // spec cannot open a second layout pass under visible text.
  if (!exercise || viz.loading) return <LoadingWorkspace summary={summary} tab={tab} />;

  return (
    <div
      className="workspace"
      ref={workspaceRef}
      style={{ "--doc-frac": `${paneFraction("doc-frac", 0.4) * 100}%` } as CSSProperties}
    >
      <DocPane
        summary={summary}
        exercise={exercise}
        tab={tab}
        status={status}
        spec={viz.spec}
        onOpenFile={(name) => openFile.current(name)}
      />
      <Splitter axis="x" target={workspaceRef} cssVar="--doc-frac" prefKey="doc-frac" />
      <CodePane summary={summary} exercise={exercise} status={status} spec={viz.spec} onStatus={onStatus} openFile={openFile} />
    </div>
  );
}

function LoadingWorkspace({ summary, tab }: Pick<Props, "summary" | "tab">) {
  return (
    <div
      className="workspace workspace-loading"
      aria-busy="true"
      style={{ "--doc-frac": `${paneFraction("doc-frac", 0.4) * 100}%` } as CSSProperties}
    >
      <section className="doc-pane" aria-label={`${tab === "problem" ? "Problem" : "Solution"} loading`}>
        <div className="loading-tabbar" aria-hidden="true">
          <span className={`loading-tab${tab === "problem" ? " is-active" : ""}`}>Problem</span>
          <span className={`loading-tab${tab === "solution" ? " is-active" : ""}`}>Solution</span>
          <span className="spacer" />
          <span className="loading-pill" />
        </div>
        <div className="doc-body loading-doc" aria-hidden="true">
          <span className="loading-line is-short" />
          <span className="loading-line is-title" />
          <span className="loading-line" />
          <span className="loading-line is-medium" />
          <span className="loading-block" />
        </div>
        <span className="sr-only" role="status">
          Loading exercise {summary.number}
        </span>
      </section>
      <div className="splitter splitter-x" aria-hidden="true" />
      <section className="code-pane" aria-label="Code loading">
        <div className="code-toolbar" aria-hidden="true">
          <span className="loading-tab is-active">main.go</span>
          <span className="loading-tab">check_test.go</span>
        </div>
        <div className="split-y">
          <div className="editor-host loading-surface" aria-hidden="true" />
          <div className="splitter splitter-y" aria-hidden="true" />
          <div className="console" aria-hidden="true">
            <div className="console-toolbar">
              <span className="loading-line is-button" />
              <span className="loading-line is-button-small" />
            </div>
            <div className="console-output loading-doc">
              <span className="loading-line is-medium" />
              <span className="loading-line is-short" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
