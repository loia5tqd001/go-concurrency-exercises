// The console (inside CodePane) and the README door (inside Markdown's
// portal) are siblings under ExerciseView. An intent is smaller than drilling
// an opener through DocPane, Markdown, and the portal, and it keeps the runner
// untouched (decision 5).
//
// A request made while no door is mounted, such as from the Solution tab,
// waits for the next door. It is consumed once, so a later exercise cannot
// inherit it.

import type { VizSpec } from "./engine/model.ts";
import { defaultParams, resolveModel } from "./engine/sim.ts";

export interface DoorIntent {
  exercise: string;
  scene: string;
  // Zero-based. A remounted player starts at 0, which the door calls step 1.
  step: number;
}

type Listener = (intent: DoorIntent) => void;

const listeners = new Set<Listener>();
let pending: DoorIntent | null = null;

export function openDoor(intent: DoorIntent): void {
  if (listeners.size === 0) {
    pending = intent;
    return;
  }
  for (const listener of listeners) listener(intent);
}

// onDoorIntent subscribes one door. The listener runs only for its exercise,
// because the page can have a door per pinned fence and an intent names one.
export function onDoorIntent(exercise: string, listener: Listener): () => void {
  const scoped: Listener = (intent) => {
    if (intent.exercise === exercise) listener(intent);
  };
  listeners.add(scoped);
  if (pending !== null) {
    const intent = pending;
    pending = null;
    scoped(intent);
  }
  return () => {
    listeners.delete(scoped);
  };
}

// specTestNames is every full test name the spec's scenes judge. The
// console links only a failing test whose full name is in this set, so a spec
// that does not name the test shows no link.
export function specTestNames(spec: VizSpec): Set<string> {
  const names = new Set<string>();
  for (const scene of spec.scenes) {
    const model = resolveModel(scene, defaultParams(scene));
    for (const test of Object.values(model.tests ?? {})) names.add(test.name);
  }
  return names;
}

// todaySceneId is the scene a link opens. The tier is the contract; the
// scene id is only how the player names it.
export function todaySceneId(spec: VizSpec): string | undefined {
  return spec.scenes.find((scene) => scene.tier === "today")?.id;
}
