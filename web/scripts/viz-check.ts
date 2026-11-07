// Checks for every visualisation spec (schema 3).
//
// A spec is a small Go program for the scheduler in src/viz/engine/sim.ts.
// The scheduler already refuses what Go would refuse; this checker proves
// what a spec could still get wrong:
//
// - provenance: every constant's text occurs in its committed file and
//   contains its value; every anchor's text occurs in its file; every test a
//   scene judges exists in the committed tests;
// - the README pin: each diagrams pin matches a plain fence of the README the
//   site renders (the working tree); HEAD lacking it is a warning;
// - code excerpts: a today scene's lines are verbatim from the committed
//   scaffold; an inside scene's lines are verbatim from the solution doc; a
//   goal scene has no code, because the Problem tab must not show the answer;
// - spoilers: no text a today or goal scene shows names an identifier that
//   only the solution declares; labels use words the learner already has;
// - the run: every scene, for every knob setting, under many seeds, ends with
//   the outcome, test results, and time its expect names, with no error;
// - budgets: chip, label, token, and text lengths, and a layout with no
//   overlapping nodes at a wide and a narrow width.
//
// Exercise .go files come from HEAD only: the owner keeps solved main.go
// files uncommitted. Docs come from the working tree, which is what the site
// renders; in CI the working tree is HEAD, so CI checks what deploys.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diagramHash } from "../src/viz/engine/diagramHash.ts";
import { collisions, layout } from "../src/viz/engine/layout.ts";
import type { Model, Params, SceneDef, VizSpec } from "../src/viz/engine/model.ts";
import { knobCombos, parseCode, resolveModel, runModel, valueText } from "../src/viz/engine/sim.ts";
import { buildTimeline } from "../src/viz/engine/timeline.ts";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(web, "..");
const specDir = join(web, "src/viz/specs");

// Every scene must end the same way under this many schedules.
export const SEEDS = 12;

export const BUDGET = {
  chip: 8,
  label: 14,
  token: 3,
  work: 16,
  testShort: 16,
  summary: 160,
  insight: 320,
  stop: 140,
  nodes: 14,
  scenesPerTier: { today: 1, goal: 1, inside: 3 },
} as const;

// The SVG is the doc width less the figure's padding and border (12 px and
// 1 px on each side), so a 300 px pane draws a 274 px graph. Check the
// widths the shots command renders: no node may overlap another.
const FIGURE_CHROME = 26;
const WIDTHS = [300 - FIGURE_CHROME, 640 - FIGURE_CHROME];

export type Reporter = (message: string) => void;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function headFile(path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repo, "show", `HEAD:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function workingFile(path: string): string | undefined {
  try {
    return readFileSync(join(repo, path), "utf8");
  } catch {
    return undefined;
  }
}

function headGoNames(id: string): string[] {
  try {
    return execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", `HEAD:${id}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((name) => name.endsWith(".go"));
  } catch {
    return [];
  }
}

// A constant or anchor names a file of the exercise, "../" plus a path from
// the repository root (solutions/<id>.md), or "solution" for the solution doc.
function readSource(id: string, file: string): string | undefined {
  if (file === "solution") return workingFile(`solutions/${id}.md`);
  const path = file.startsWith("../") ? file.slice(3) : `${id}/${file}`;
  // Go files come from HEAD only; docs from the working tree, as the site
  // renders them.
  return path.endsWith(".go") ? headFile(path) : workingFile(path);
}

// ---------------------------------------------------------------------------
// README fences
// ---------------------------------------------------------------------------

interface Fence {
  hash: string;
  body: string;
  info: string;
}

export function fences(md: string): Fence[] {
  const out: Fence[] = [];
  let inFence = false;
  let info = "";
  let body: string[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("```")) {
      if (inFence) body.push(line);
      continue;
    }
    if (inFence) {
      const text = body.join("\n");
      out.push({ body: text, info, hash: diagramHash(text) });
      inFence = false;
      body = [];
      continue;
    }
    inFence = true;
    info = line.slice(3).trim();
    body = [];
  }
  return out;
}

const diagramChars = /-->|<--|\+--|[─│┌┐└┘├┤┬┴▶◀▼▲→←↓↑]/;

function plainFences(md: string): Fence[] {
  return fences(md).filter((fence) => fence.info === "" || fence.info === "text");
}

export function headDiagramWarning(id: string, head: string | undefined): string | undefined {
  const readme = `${id}/README.md`;
  if (head === undefined) {
    return `${id}: HEAD has no ${readme}. The commit that adds this spec must include ${readme} with its diagram.`;
  }
  if (!plainFences(head).some((fence) => diagramChars.test(fence.body))) {
    return `${id}: the HEAD ${readme} has no plain-fence diagram. The commit that adds this spec must include ${readme}.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spoilers
// ---------------------------------------------------------------------------

// Go keywords and builtins count as solution identifiers, so a goal text
// cannot name "select" before the README or the scaffold does.
const GO_WORDS = new Set(
  (
    "break case chan const continue default defer else fallthrough for func go goto if import interface map " +
    "package range return select struct switch type var bool byte complex64 complex128 error float32 float64 " +
    "int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false iota nil " +
    "append cap close complex copy delete imag len make new panic print println real recover"
  ).split(" "),
);

function goBlocks(doc: string): string {
  const blocks: string[] = [];
  let inFence = false;
  let go = false;
  let body: string[] = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("```")) {
      if (inFence) body.push(line);
      continue;
    }
    if (inFence) {
      if (go) blocks.push(body.join("\n"));
      inFence = false;
      body = [];
      continue;
    }
    inFence = true;
    go = /^```(?:go|golang)\b/.test(line);
    body = [];
  }
  return blocks.join("\n");
}

// The names the solution's code declares or uses that look like code.
export function solutionIdentifiers(code: string): Set<string> {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  const declared = new Set<string>();
  for (const match of stripped.matchAll(/\b(?:var|const|type|func)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) declared.add(match[1]!);
  for (const match of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:=/g)) {
    for (const name of match[1]!.split(",")) declared.add(name.trim());
  }
  for (const match of stripped.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=/g)) {
    declared.add(match[1]!);
    declared.add(match[2]!);
  }
  const identifiers = new Set<string>();
  for (const token of stripped.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) ?? []) {
    if (declared.has(token) || /[a-z][A-Z]/.test(token) || token.includes(".") || token.includes("_") || GO_WORDS.has(token)) {
      identifiers.add(token);
    }
  }
  return identifiers;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordIn(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapePattern(word)}([^A-Za-z0-9_]|$)`).test(text);
}

export interface Sources {
  readme: string;
  // Every committed .go file of the exercise, joined.
  go: string;
  // The Go code of the solution doc.
  solution: string | undefined;
}

interface TextRef {
  where: string;
  text: string;
}

// Every text a Problem scene shows: the words the author wrote and the words
// the run derives (a work label, "out <-").
function problemTexts(scene: SceneDef, model: Model, derived: Set<string>): TextRef[] {
  const at = scene.id;
  const texts: TextRef[] = [
    { where: `${at} summary`, text: scene.summary },
    { where: `${at} insight`, text: model.insight },
    { where: `${at} chip`, text: scene.chip },
  ];
  for (const [i, stop] of (model.stops ?? []).entries()) texts.push({ where: `${at} stop ${i + 1}`, text: stop.say });
  for (const [id, node] of Object.entries(model.nodes)) texts.push({ where: `${at} node ${id}`, text: node.label });
  for (const [id, test] of Object.entries(model.tests ?? {})) texts.push({ where: `${at} test ${id}`, text: test.short });
  for (const knob of scene.knobs ?? []) {
    texts.push({ where: `${at} knob ${knob.key}`, text: knob.label });
    for (const option of knob.options) if (typeof option === "string") texts.push({ where: `${at} knob ${knob.key} option`, text: option });
  }
  if (model.clock?.budget !== undefined) texts.push({ where: `${at} clock budget`, text: model.clock.budget.label });
  for (const [id, node] of Object.entries(model.nodes)) {
    if (node.kind !== "fact") continue;
    if (node.unit !== undefined) texts.push({ where: `${at} fact ${id} unit`, text: node.unit });
    for (const state of node.states ?? []) texts.push({ where: `${at} fact ${id} state`, text: state });
  }
  for (const text of derived) texts.push({ where: `${at} derived text`, text });
  return texts;
}

export function checkSpoilers(
  id: string,
  spec: VizSpec,
  scene: SceneDef,
  model: Model,
  derived: Set<string>,
  sources: Sources,
  report: Reporter,
): void {
  if (sources.solution === undefined) return;
  const allow = new Set(Object.keys(spec.spoilerOk ?? {}));
  const known = `${sources.readme}\n${sources.go}`;
  // Whole words: the solution's `res` is not the README's "result".
  const solutionOnly = [...solutionIdentifiers(sources.solution)].filter((word) => !allow.has(word) && !wordIn(known, word));
  const lines = sources.solution.split("\n");
  for (const ref of problemTexts(scene, model, derived)) {
    for (const word of solutionOnly) {
      if (!wordIn(ref.text, word)) continue;
      const line = lines.findIndex((l) => wordIn(l, word));
      report(
        `${id}/${ref.where}: "${word}" appears only in the solution${line < 0 ? "" : ` (Go line ${line + 1})`}. ` +
          `Use a word the README or the scaffold already has, or move this text to an inside scene.`,
      );
    }
  }
}

// A label a Problem scene shows must be a word the learner already has: from
// the README or the committed Go files, optionally with a member suffix -n.
export function checkVocabulary(id: string, scene: SceneDef, model: Model, sources: Sources, report: Reporter): void {
  const known = `${sources.readme}\n${sources.go}`;
  for (const [nodeId, node] of Object.entries(model.nodes)) {
    const base = node.label.replace(/-\d+$/, "");
    if (known.includes(node.label) || known.includes(base)) continue;
    report(
      `${id}/${scene.id}: node ${nodeId} is labelled "${node.label}", a word neither the README nor the committed code uses. ` +
        `Problem scenes use the learner's words; rename it, or move the scene to the inside tier.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Code excerpts
// ---------------------------------------------------------------------------

export function checkCode(id: string, scene: SceneDef, model: Model, report: Reporter, read = readSource): void {
  const code = model.code;
  if (code === undefined) return;
  if (scene.tier === "goal") {
    report(`${id}/${scene.id}: a goal scene shows no code. The Problem tab must not show the answer; move the code to an inside scene.`);
    return;
  }
  if (scene.tier === "today" && code.file === "solution") {
    report(`${id}/${scene.id}: a today scene shows the scaffold, not the solution; set code.file to the scaffold file`);
    return;
  }
  const source = read(id, code.file);
  if (source === undefined) {
    report(`${id}/${scene.id}: code.file "${code.file}" cannot be read${code.file.endsWith(".go") ? " at HEAD" : ""}`);
    return;
  }
  const have = new Set(source.split("\n").map((line) => line.trim()));
  const lines = parseCode(code);
  for (const [n, line] of lines.entries()) {
    if (line.gap || line.text.trim() === "") continue;
    if (!have.has(line.text.trim())) {
      report(`${id}/${scene.id}: code line ${n + 1} "${line.text.trim()}" is not a line of ${code.file}. Copy lines verbatim; mark a cut with "…".`);
    }
    for (const owner of line.owners) {
      const node = model.nodes[owner];
      if (node === undefined || node.kind !== "goroutine") {
        report(`${id}/${scene.id}: code line ${n + 1} is tagged @${owner}, which is not a goroutine node`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// One spec
// ---------------------------------------------------------------------------

function len(text: string): number {
  return [...text].length;
}

function checkModelShape(id: string, scene: SceneDef, P: Params, model: Model, report: Reporter): void {
  const where = `${id}/${scene.id}${Object.keys(P).length > 0 ? ` ${JSON.stringify(P)}` : ""}`;
  const nodes = Object.entries(model.nodes);
  if (nodes.length > BUDGET.nodes) report(`${where}: ${nodes.length} nodes; the limit is ${BUDGET.nodes}`);
  const mains = nodes.filter(([, node]) => node.kind === "goroutine" && node.main === true);
  if (mains.length !== 1) {
    report(`${where}: mark exactly one goroutine main: true (the caller); found ${mains.length}`);
  }
  const labels = new Map<string, string>();
  for (const [nodeId, node] of nodes) {
    const other = labels.get(node.label);
    if (other !== undefined) report(`${where}: nodes ${other} and ${nodeId} share the label "${node.label}"; labels are unique within a scene`);
    labels.set(node.label, nodeId);
  }
  const seen = new Map<string, string>();
  for (const [nodeId, node] of nodes) {
    if (len(node.label) > BUDGET.label) report(`${where}: node ${nodeId} label "${node.label}" is over ${BUDGET.label} characters`);
    const [col, row] = node.pos;
    if (!(col >= 0 && row >= 0 && Number.isFinite(col) && Number.isFinite(row))) {
      report(`${where}: node ${nodeId} has pos [${col}, ${row}]; use columns and rows from 0`);
    }
    const key = `${col},${row}`;
    const other = seen.get(key);
    if (other !== undefined) report(`${where}: nodes ${other} and ${nodeId} share pos [${col}, ${row}]`);
    seen.set(key, nodeId);
  }
  if (len(model.insight) > BUDGET.insight) report(`${where}: insight is ${len(model.insight)} characters; the limit is ${BUDGET.insight}`);
  for (const [i, stop] of (model.stops ?? []).entries()) {
    if (len(stop.say) > BUDGET.stop) report(`${where}: stop ${i + 1} is ${len(stop.say)} characters; the limit is ${BUDGET.stop}`);
  }
  for (const [testId, test] of Object.entries(model.tests ?? {})) {
    if (len(test.short) > BUDGET.testShort) report(`${where}: test ${testId} short name "${test.short}" is over ${BUDGET.testShort} characters`);
  }
  for (const [testId] of Object.entries(model.expect.tests ?? {})) {
    if (model.tests?.[testId] === undefined) report(`${where}: expect names test ${testId}, which the scene does not declare`);
  }
  // A chip the learner sees must have a checked verdict.
  for (const testId of Object.keys(model.tests ?? {})) {
    if (model.expect.tests?.[testId] === undefined) {
      report(`${where}: test ${testId} shows on screen, so expect.tests must say whether it passes or fails`);
    }
  }
}

// What playback relies on. A broken timeline shows up as a stuck or jumping
// scrubber, so the shape is checked here, where a spec author sees it.
export function checkTimeline(where: string, run: Parameters<typeof buildTimeline>[0], report: Reporter): void {
  const tl = buildTimeline(run, 1);
  let at = 0;
  for (const [i, beat] of tl.beats.entries()) {
    if (!Number.isFinite(beat.d) || beat.d <= 0) report(`${where}: beat ${i} has a duration of ${beat.d}; playback would stall or jump`);
    if (Math.abs(beat.start - at) > 1e-6) report(`${where}: beat ${i} starts at ${beat.start}, not where the last one ended (${at})`);
    at = beat.start + beat.d;
    if (beat.t1 < beat.t0) report(`${where}: beat ${i} runs the clock backwards`);
  }
  if (Math.abs(tl.total - at) > 1e-6) report(`${where}: the timeline's total ${tl.total} is not the sum of its beats ${at}`);
  const stopsHeld = tl.beats.filter((b) => b.stop !== undefined).length;
  const stopsFound = run.stopAt.filter((i) => i >= 0).length;
  if (stopsHeld !== stopsFound) report(`${where}: ${stopsFound} stops matched but ${stopsHeld} landed on a batch end`);
}

// The smallest scale the graph may be drawn at, per width. At a common pane
// it must stay nearly full size; on a phone it may shrink, since the large
// view shows it whole.
const MIN_SCALE: Record<number, number> = { [WIDTHS[0]!]: 0.6, [WIDTHS[1]!]: 0.9 };

function checkLayout(id: string, scene: SceneDef, model: Model, edges: Parameters<typeof layout>[1], report: Reporter): void {
  for (const width of WIDTHS) {
    const lay = layout(model, edges, width);
    for (const [a, b] of collisions(lay)) {
      report(`${id}/${scene.id} at ${width + FIGURE_CHROME} px: ${a} and ${b} overlap even scaled down; move one to another column or row`);
    }
    const least = MIN_SCALE[width] ?? 0.6;
    if (lay.scale < least) {
      report(
        `${id}/${scene.id} at ${width + FIGURE_CHROME} px: the graph needs ${Math.round(lay.width)} px and shrinks to ${Math.round(lay.scale * 100)}% ` +
          `(at least ${Math.round(least * 100)}%). Use fewer columns or rows, or fewer nodes.`,
      );
    }
  }
}

// A number must stand alone in its text: 10 is not in "const workers = 100".
// A string value may sit anywhere.
export function holdsValue(text: string, value: number | string): boolean {
  if (typeof value !== "number") return text.includes(value);
  const escaped = escapePattern(String(value));
  return new RegExp(`(?<![0-9.])${escaped}(?![0-9]|\\.[0-9])`).test(text);
}

export function checkSpec(id: string, spec: VizSpec, report: Reporter, sources: Sources | undefined, read = readSource): void {
  if (spec.schema !== 3) {
    report(`${id}: schema ${String(spec.schema)}; this checker reads schema 3`);
    return;
  }
  if (spec.exercise !== id) report(`${id}: the file is ${id}.ts but exercise is "${spec.exercise}"`);

  for (const [name, constant] of Object.entries(spec.constants ?? {})) {
    const text = read(id, constant.file);
    if (text === undefined) report(`${id}: constant ${name}: cannot read ${constant.file}`);
    else if (!text.includes(constant.text)) report(`${id}: constant ${name}: "${constant.text}" is not in ${constant.file}`);
    else if (!holdsValue(constant.text, constant.value)) {
      report(`${id}: constant ${name}: its text "${constant.text}" does not contain its value ${String(constant.value)}`);
    }
  }
  for (const anchor of spec.anchors ?? []) {
    const text = read(id, anchor.file);
    if (text === undefined || !text.includes(anchor.text)) report(`${id}: anchor "${anchor.text}" is not in ${anchor.file}`);
  }
  for (const [word, reason] of Object.entries(spec.spoilerOk ?? {})) {
    if (word.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
      report(`${id}: spoilerOk["${word}"] needs a word and a reason that says why the README already implies it`);
    }
  }

  const ids = new Set<string>();
  const perTier: Record<string, number> = {};
  const tests = sources?.go ?? "";
  for (const scene of spec.scenes) {
    if (ids.has(scene.id)) report(`${id}: two scenes have id ${scene.id}`);
    ids.add(scene.id);
    perTier[scene.tier] = (perTier[scene.tier] ?? 0) + 1;
    if (len(scene.chip) > BUDGET.chip) report(`${id}/${scene.id}: chip "${scene.chip}" is over ${BUDGET.chip} characters`);
    if (len(scene.summary) > BUDGET.summary) report(`${id}/${scene.id}: summary is over ${BUDGET.summary} characters`);
    for (const knob of scene.knobs ?? []) {
      if (!knob.options.includes(knob.value)) report(`${id}/${scene.id}: knob ${knob.key}'s value is not one of its options`);
    }

    for (const P of knobCombos(scene)) {
      const where = `${id}/${scene.id}${Object.keys(P).length > 0 ? ` ${JSON.stringify(P)}` : ""}`;
      let model: Model;
      try {
        model = resolveModel(scene, P);
      } catch (error) {
        report(`${where}: the model threw: ${String(error)}`);
        continue;
      }
      checkModelShape(id, scene, P, model, report);
      checkCode(id, scene, model, report, read);
      for (const test of Object.values(model.tests ?? {})) {
        if (sources !== undefined && !tests.includes(`func ${test.name}(`)) {
          report(`${where}: test ${test.name} is not a func in the committed _test.go files`);
        }
      }

      const derived = new Set<string>();
      const workLabels = new Set<string>();
      let first: ReturnType<typeof runModel> | undefined;
      const outcomes = new Map<string, number[]>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        let run: ReturnType<typeof runModel>;
        try {
          run = runModel(model, { P, seed });
        } catch (error) {
          report(`${where} seed ${seed}: the run threw: ${String(error)}`);
          break;
        }
        first ??= run;
        for (const error of run.errors) report(`${where} seed ${seed}: ${error}`);
        const got = [run.outcome, ...Object.entries(model.expect.tests ?? {}).map(([k]) => `${k}=${run.world.tests[k] ?? "unjudged"}`), ...(model.expect.t !== undefined ? [`t=${run.t}`] : [])].join(" ");
        outcomes.set(got, [...(outcomes.get(got) ?? []), seed]);
        for (const step of run.steps) {
          for (const view of Object.values(step.world.g)) {
            if (view.label !== undefined) {
              derived.add(view.label);
              workLabels.add(view.label);
            }
            if (view.why !== undefined) derived.add(view.why);
            if (view.panic !== undefined) derived.add(view.panic);
          }
          for (const tok of Object.values(step.world.tokens)) {
            if (typeof tok.v === "string" && tok.glyph === undefined) derived.add(tok.v);
            if (tok.glyph === undefined && len(valueText(tok.v)) > BUDGET.token) {
              report(`${where}: token value "${valueText(tok.v)}" is over ${BUDGET.token} characters; show a short value`);
            }
          }
        }
      }
      // Work labels are the author's words. A derived "why" such as
      // "forwarders.Wait()" follows the node's label, and the box shrinks
      // its type a little to fit it.
      for (const label of workLabels) {
        if (len(label) > BUDGET.work) report(`${where}: work label "${label}" is over ${BUDGET.work} characters`);
      }
      const want = [model.expect.outcome, ...Object.entries(model.expect.tests ?? {}).map(([k, v]) => `${k}=${v}`), ...(model.expect.t !== undefined ? [`t=${model.expect.t}`] : [])].join(" ");
      for (const [got, seeds] of outcomes) {
        if (got !== want) {
          report(`${where}: expected "${want}", but seeds ${seeds.join(",")} end "${got}"${first !== undefined && first.verdict !== "" ? ` (${first.verdict})` : ""}`);
        }
      }
      if (first !== undefined) {
        for (const [i, at] of first.stopAt.entries()) {
          if (at < 0) report(`${where}: stop ${i + 1} ("${model.stops?.[i]?.say ?? ""}") matches no event`);
        }
        checkLayout(id, scene, model, first.edges, report);
        checkTimeline(where, first, report);
      }
      if (sources !== undefined && scene.tier !== "inside") {
        checkVocabulary(id, scene, model, sources, report);
        checkSpoilers(id, spec, scene, model, derived, sources, report);
      }
    }
  }
  for (const [tier, n] of Object.entries(perTier)) {
    const most = BUDGET.scenesPerTier[tier as keyof typeof BUDGET.scenesPerTier];
    if (most !== undefined && n > most) report(`${id}: ${n} ${tier} scenes; the limit is ${most}`);
  }
  // The door mounts a goal scene on the fence diagrams.goal names.
  if (spec.scenes.some((scene) => scene.tier === "goal") && spec.diagrams.goal === undefined) {
    report(`${id}: a goal scene needs diagrams.goal; run npm run viz -- pin ${id}`);
  }
}

export function checkPins(id: string, spec: VizSpec, readme: string | undefined, report: Reporter): void {
  if (readme === undefined) {
    report(`${id}: no ${id}/README.md`);
    return;
  }
  const hashes = new Set(plainFences(readme).map((fence) => fence.hash));
  const tiers = new Set(spec.scenes.map((scene) => scene.tier));
  for (const tier of ["today", "goal"] as const) {
    if (!tiers.has(tier)) continue;
    const pin = tier === "goal" ? spec.diagrams.goal : spec.diagrams.today;
    if (pin !== undefined && !hashes.has(pin)) {
      report(
        `${id}: diagrams.${tier} = ${pin} matches no plain fence in ${id}/README.md. The diagram changed or is not saved. ` +
          `Re-read it, update the scenes if the story changed, then run: npm run viz -- pin ${id}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function specFiles(): string[] {
  return readdirSync(specDir)
    .filter((name) => /^[0-9].*\.ts$/.test(name))
    .sort();
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const failures: string[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const file of specFiles()) {
    const id = file.slice(0, -3);
    if (wanted.length > 0 && !wanted.some((w) => id === w || id.startsWith(`${w}-`))) continue;
    checked++;
    const report: Reporter = (message) => failures.push(message);
    let spec: VizSpec;
    try {
      spec = ((await import(pathToFileURL(join(specDir, file)).href)) as { default: VizSpec }).default;
    } catch (error) {
      failures.push(`${id}: the spec does not load: ${String(error)}`);
      continue;
    }
    if (headFile(`${id}/README.md`) === undefined && workingFile(`${id}/README.md`) === undefined) {
      failures.push(`${id}: no exercise folder ${id}/`);
      continue;
    }
    const go = headGoNames(id)
      .map((name) => headFile(`${id}/${name}`) ?? "")
      .join("\n");
    const doc = workingFile(`solutions/${id}.md`);
    const readme = workingFile(`${id}/README.md`);
    const sources: Sources = { readme: readme ?? "", go, solution: doc === undefined ? undefined : goBlocks(doc) };
    try {
      checkPins(id, spec, readme, report);
      checkSpec(id, spec, report, sources);
    } catch (error) {
      failures.push(`${id}: the spec is malformed (a field is missing or has the wrong type): ${String(error)}`);
    }
    const warning = headDiagramWarning(id, headFile(`${id}/README.md`));
    if (warning !== undefined) warnings.push(warning);
  }
  if (checked === 0) failures.push(wanted.length > 0 ? `no spec matches ${wanted.join(", ")}` : "no spec files found");
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  // One fault can show at every step and seed; say it once.
  const unique = [...new Set(failures)];
  if (unique.length > 0) {
    for (const failure of unique) console.error(`FAIL ${failure}`);
    console.error(`\n${unique.length} problem(s) in ${checked} spec(s).`);
    process.exit(1);
  }
  console.log(`ok: ${checked} spec(s), every scene under ${SEEDS} schedules.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
