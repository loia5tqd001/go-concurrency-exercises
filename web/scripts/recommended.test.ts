import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { ExerciseSummary } from "../src/data.ts";
import { RECOMMENDED_IDS, defaultScope, recommendedExercises } from "../src/recommended.ts";

const generated = JSON.parse(
  readFileSync(new URL("../src/generated/exercises.json", import.meta.url), "utf8"),
) as { exercises: ExerciseSummary[] };

test("the recommended path is short, unique, and starts with 06", () => {
  assert.equal(RECOMMENDED_IDS.length, 15);
  assert.equal(new Set(RECOMMENDED_IDS).size, RECOMMENDED_IDS.length);
  assert.equal(RECOMMENDED_IDS[0], "06-fan-out-fan-in");
  assert.equal(RECOMMENDED_IDS.some((id) => /^0[0-5]-/.test(id)), false);
});

test("every recommendation exists, runs in the browser, and has a visualisation", () => {
  const byId = new Map(generated.exercises.map((exercise) => [exercise.id, exercise]));
  for (const id of RECOMMENDED_IDS) {
    const exercise = byId.get(id);
    assert.ok(exercise, `${id} is not an exercise`);
    assert.equal(exercise.unsupported, undefined, `${id} cannot run in the browser`);
    assert.ok(existsSync(new URL(`../src/viz/specs/${id}.ts`, import.meta.url)), `${id} has no visualisation`);
  }
});

test("recommendedExercises returns the curated order, not folder order", () => {
  const shuffled = [...generated.exercises].reverse();
  assert.deepEqual(
    recommendedExercises(shuffled).map((exercise) => exercise.id),
    [...RECOMMENDED_IDS],
  );
});

test("a direct link outside the recommended path opens the full list", () => {
  assert.equal(defaultScope("00-limit-crawler"), "all");
  assert.equal(defaultScope("04-graceful-sigint"), "all");
  assert.equal(defaultScope("06-fan-out-fan-in"), "recommended");
  assert.equal(defaultScope(), "recommended");
});
