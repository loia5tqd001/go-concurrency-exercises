import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadExercise, type Exercise, type ExerciseSummary } from "../data.ts";
import type { Status } from "../storage.ts";
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

  if (error) return <div className="placeholder">Could not load this exercise: {error}</div>;
  if (!exercise) return <div className="placeholder">Loading…</div>;

  return (
    <div
      className="workspace"
      ref={workspaceRef}
      style={{ "--doc-frac": `${paneFraction("doc-frac", 0.4) * 100}%` } as CSSProperties}
    >
      <DocPane summary={summary} exercise={exercise} tab={tab} status={status} onOpenFile={(name) => openFile.current(name)} />
      <Splitter axis="x" target={workspaceRef} cssVar="--doc-frac" prefKey="doc-frac" />
      <CodePane summary={summary} exercise={exercise} onStatus={onStatus} openFile={openFile} />
    </div>
  );
}
