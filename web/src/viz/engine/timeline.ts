// Playback. A run is a list of steps at virtual times. The timeline turns it
// into beats the player can show:
//
//   time beat   the clock moves from t0 to t1; work bars and timers advance
//   batch beat  the clock stands still while values fly between nodes
//
// Channel operations take no time in Go, so the clock stops while a batch
// plays. Steps at one instant join one batch until a value would move twice,
// so a chain (receive, then forward) plays in order and independent moves
// (ten workers finishing together) play together.

import type { Move, Run, World } from "./model.ts";

export interface Beat {
  kind: "time" | "batch";
  t0: number;
  t1: number;
  from: World;
  to: World;
  moves: Move[];
  // Step indexes in this batch.
  steps: number[];
  // Display duration in milliseconds at 1× speed, and the offset it starts at.
  d: number;
  start: number;
  // The index of a stop that ends with this beat.
  stop?: number;
}

export interface Timeline {
  beats: Beat[];
  total: number;
  slow: number;
}

// Display milliseconds for a batch. The clock stands still while values move,
// so a long flight reads as a stall in the clock. A single hop is short; a
// hand-off through a channel flies two legs and gets a little more.
const BATCH_VIA = 440;
const BATCH_MOVE = 320;
const BATCH_STATE = 180;

export function buildTimeline(run: Run, slow: number): Timeline {
  const beats: Beat[] = [];
  const stopAt = new Map<number, number>();
  run.stopAt.forEach((index, stop) => {
    if (index >= 0) stopAt.set(index, stop);
  });

  let world = run.initial;
  let t = 0;
  let start = 0;
  const push = (beat: Omit<Beat, "start">): void => {
    beats.push({ ...beat, start });
    start += beat.d;
  };

  let i = 0;
  const steps = run.steps;
  while (i < steps.length) {
    const first = steps[i]!;
    if (first.event.t > t) {
      const to = { ...world, t: first.event.t };
      push({ kind: "time", t0: t, t1: first.event.t, from: world, to, moves: [], steps: [], d: (first.event.t - t) * slow });
      world = to;
      t = first.event.t;
    }

    const moved = new Set<number>();
    const batch: number[] = [];
    const moves: Move[] = [];
    let stop: number | undefined;
    while (i < steps.length && steps[i]!.event.t === t) {
      const step = steps[i]!;
      if (batch.length > 0 && step.moves.some((m) => moved.has(m.tok))) break;
      for (const m of step.moves) moved.add(m.tok);
      moves.push(...step.moves);
      batch.push(i);
      i++;
      const s = stopAt.get(i - 1);
      if (s !== undefined) {
        stop = s;
        break;
      }
    }
    const to = steps[batch[batch.length - 1]!]!.world;
    const d = moves.some((m) => m.via !== undefined) ? BATCH_VIA : moves.length > 0 ? BATCH_MOVE : BATCH_STATE;
    push({ kind: "batch", t0: t, t1: t, from: world, to, moves, steps: batch, d, stop });
    world = to;
  }

  // A run that ends by reaching its time limit ends with the clock moving.
  if (run.t > t) {
    const to = { ...run.world, t: run.t };
    push({ kind: "time", t0: t, t1: run.t, from: world, to, moves: [], steps: [], d: (run.t - t) * slow });
  }
  return { beats, total: start, slow };
}

export interface Frame {
  beat: Beat;
  index: number;
  // Progress through the beat, 0 to 1.
  f: number;
  // The simulated time on the clock.
  t: number;
  // At the very end of the timeline.
  end: boolean;
}

export function frameAt(timeline: Timeline, p: number): Frame | undefined {
  const { beats, total } = timeline;
  if (beats.length === 0) return undefined;
  if (p >= total) {
    const index = beats.length - 1;
    const beat = beats[index]!;
    return { beat, index, f: 1, t: beat.t1, end: true };
  }
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid]!.start <= p) lo = mid;
    else hi = mid - 1;
  }
  const beat = beats[lo]!;
  const f = beat.d <= 0 ? 1 : Math.min(1, Math.max(0, (p - beat.start) / beat.d));
  const t = beat.kind === "time" ? beat.t0 + (beat.t1 - beat.t0) * f : beat.t0;
  return { beat, index: lo, f, t, end: false };
}

const EPS = 0.5;

// The end of the next batch after p: one press of Step.
export function nextStop(timeline: Timeline, p: number): number {
  for (const beat of timeline.beats) {
    const end = beat.start + beat.d;
    if (beat.kind === "batch" && end > p + EPS) return end;
  }
  return timeline.total;
}

// The end of the batch before p: one press of Step back.
export function prevStop(timeline: Timeline, p: number): number {
  let best = 0;
  for (const beat of timeline.beats) {
    const end = beat.start + beat.d;
    if (beat.kind === "batch" && end < p - EPS) best = end;
  }
  return best;
}

// The display position where the clock first reads t, for marks on the
// scrubber.
export function positionOf(timeline: Timeline, t: number): number | undefined {
  for (const beat of timeline.beats) {
    if (beat.kind !== "time") continue;
    if (t >= beat.t0 && t <= beat.t1) {
      const span = beat.t1 - beat.t0;
      return beat.start + (span <= 0 ? 0 : ((t - beat.t0) / span) * beat.d);
    }
  }
  return undefined;
}

// The step whose event the player names: the last step of the last batch
// that has finished playing at p.
export function stepAt(timeline: Timeline, p: number): number | undefined {
  let last: number | undefined;
  for (const beat of timeline.beats) {
    if (beat.start > p) break;
    if (beat.kind === "batch" && beat.start + beat.d <= p + EPS) last = beat.steps[beat.steps.length - 1];
  }
  return last;
}

// The display position at the end of the batch that holds step i.
export function positionOfStep(timeline: Timeline, i: number): number {
  for (const beat of timeline.beats) {
    if (beat.kind === "batch" && beat.steps.includes(i)) return beat.start + beat.d;
  }
  return 0;
}

// Real milliseconds per simulated millisecond, so a scene plays in about
// four and a half seconds of clock time at 1×.
export function slowFor(longest: number): number {
  if (longest <= 0) return 1;
  return Math.min(30, Math.max(0.02, 4500 / longest));
}
