import type { ExerciseSummary } from "./data.ts";

export type ExerciseScope = "recommended" | "all";

// A short first pass, not a quality ranking. Every entry is browser-runnable
// and visualised, and the sequence samples the distinct ideas most useful to
// a new visitor: fan-out, cancellation, bounded concurrency, pipelines,
// mutexes, shutdown, deadlines, deduplication, and load shedding.
export const RECOMMENDED_IDS = [
  "06-fan-out-fan-in",
  "07-or-done-channel",
  "08-pipeline",
  "09-context-cancellation",
  "10-semaphore",
  "11-worker-pool",
  "14-tee-channel",
  "16-errgroup-failfast",
  "18-bounded-pipeline-backpressure",
  "21-dining-philosophers",
  "22-circuit-breaker",
  "25-graceful-multistage-shutdown",
  "31-serve-timeout-race",
  "35-singleflight",
  "39-load-shedding",
] as const;

const recommended = new Set<string>(RECOMMENDED_IDS);

export function isRecommended(id: string): boolean {
  return recommended.has(id);
}

export function defaultScope(current?: string): ExerciseScope {
  return current !== undefined && !isRecommended(current) ? "all" : "recommended";
}

export function recommendedExercises(exercises: readonly ExerciseSummary[]): ExerciseSummary[] {
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  return RECOMMENDED_IDS.flatMap((id) => {
    const exercise = byId.get(id);
    return exercise === undefined ? [] : [exercise];
  });
}
