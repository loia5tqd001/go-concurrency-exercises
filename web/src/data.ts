import index from "./generated/exercises.json";

export interface ExerciseSummary {
  id: string;
  number: string;
  title: string;
  difficulty: string;
  topics: string[] | null;
  importPath: string;
  data: string;
  unsupported?: string;
}

export interface ExerciseFile {
  name: string;
  content: string;
  editable: boolean;
  test: boolean;
}

export interface Exercise {
  id: string;
  readme: string;
  solution: string;
  files: ExerciseFile[];
  testMain: string;
  tests: string[] | null;
}

export interface Site {
  module: string;
  goVersion: string;
  lang: string;
  commit: string;
  repoUrl: string;
  home: string;
  exercises: ExerciseSummary[];
}

export const site = index as Site;
export const exerciseById = new Map(site.exercises.map((e) => [e.id, e]));

const fetched = new Map<string, Promise<unknown>>();

function fetchJSON<T>(url: string): Promise<T> {
  let p = fetched.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
    // Let a failed fetch be retried on the next visit.
    p.catch(() => fetched.delete(url));
    fetched.set(url, p);
  }
  return p as Promise<T>;
}

export const loadExercise = (s: ExerciseSummary) => fetchJSON<Exercise>(s.data);
export const loadHome = () => fetchJSON<{ readme: string }>(site.home);

// packageDir is where an exercise's files live inside the in-browser
// filesystem; panics and test output show paths under it.
export const packageDir = (id: string) => `/go-concurrency-exercises/${id}`;

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl";
