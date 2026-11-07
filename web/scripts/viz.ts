// Authoring commands for the visualisations:
//
//   npm run viz -- new <id> [--today N] [--goal N]
//   npm run viz -- pin <id> [--today N] [--goal N]
//   npm run viz -- shots [id ...] [--widths 216,288] [--themes light,dark] [--out DIR]
//
// `new` copies specs/_template.ts, fills `exercise`, and writes both pins
// from the README. `pin` recomputes both pins after a README diagram edit. A
// diagram fence is a plain ``` or ```text fence whose body has an arrow or a
// box-drawing character, the same test the readme-diagram lint rule uses.
//
// `shots` renders every scene's last step in headless Chrome and asserts the
// pixel rules from the artist review. See scripts/viz-shots.ts.
//
// One diagram fence pins both tiers, so the commands need no flags. When the
// README has several diagram fences, the commands list them and stop unless
// --today and --goal choose one each; they never guess which fence draws
// which state.
//
// `npm run check-visuals` checks every pin against the working-tree README.
// The `make lint` rule viz-diagram checks it against the committed README,
// and against the staged README in the commit gate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diagramHash } from "../src/viz/engine/diagramHash.ts";
import { runShots } from "./viz-shots.ts";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(web, "..");
const templateFile = join(web, "src/viz/specs/_template.ts");
const specDir = join(web, "src/viz/specs");

// The readme-diagram lint rule's test. A fence with no arrow or box drawing
// is a command transcript, such as the "go test" block, not a diagram.
const DIAGRAM_CHARS = /-->|<--|\+--|[─│┌┐└┘├┤┬┴▶◀▼▲→←↓↑]/;

interface Fence {
  // 1-based among the diagram fences, the number the command prints.
  index: number;
  hash: string;
  firstLine: string;
}

interface Options {
  command: "new" | "pin";
  id: string;
  today?: number;
  goal?: number;
}

function usage(): string {
  return [
    "usage: npm run viz -- new <id> [--today N] [--goal N]",
    "       npm run viz -- pin <id> [--today N] [--goal N]",
    "       npm run viz -- shots [id ...] [--widths 216,288] [--themes light,dark] [--out DIR]",
    "",
    "new    writes src/viz/specs/<id>.ts from _template.ts and the README pins.",
    "pin    rewrites diagrams.today and diagrams.goal from the README.",
    "shots  renders every scene's last step and checks the pixel rules.",
    "",
    "N is 1-based among the README's diagram fences. One diagram fence pins",
    "both tiers. Several fences need --today N and --goal N.",
  ].join("\n");
}

// A plain fence is ``` or ```text. An annotated fence (```go, ```sh) is a code
// sample, so it never carries a diagram pin.
function diagramFences(md: string): Fence[] {
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
      if ((info === "" || info === "text") && DIAGRAM_CHARS.test(body.join("\n"))) {
        out.push({
          index: out.length + 1,
          hash: diagramHash(body.join("\n")),
          firstLine: body.find((part) => part.trim() !== "")?.trim() ?? "(empty fence)",
        });
      }
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

function readmeFor(id: string): string {
  const file = join(repo, id, "README.md");
  if (!existsSync(file)) {
    throw new Error(`no ${id}/README.md; the spec needs an exercise README with a diagram`);
  }
  return readFileSync(file, "utf8");
}

function parseNumber(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${flag} needs a fence number`);
  }
  return Number(value);
}

function parseArgs(argv: string[]): Options {
  const [command, id, ...rest] = argv;
  if (command !== "new" && command !== "pin") {
    throw new Error(usage());
  }
  if (id === undefined || id.startsWith("-")) {
    throw new Error(usage());
  }
  let today: number | undefined;
  let goal: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--today") {
      today = parseNumber(rest[++i], "--today");
    } else if (arg.startsWith("--today=")) {
      today = parseNumber(arg.slice("--today=".length), "--today");
    } else if (arg === "--goal") {
      goal = parseNumber(rest[++i], "--goal");
    } else if (arg.startsWith("--goal=")) {
      goal = parseNumber(arg.slice("--goal=".length), "--goal");
    } else {
      throw new Error(`unknown argument "${arg}"\n\n${usage()}`);
    }
  }
  return { command, id: id.replace(/\/+$/, ""), today, goal };
}

function listing(command: Options["command"], id: string, fences: Fence[]): string {
  return [
    `${id}: the README has ${fences.length} diagram fences. Pick one:`,
    ...fences.map((f) => `  ${f.index}  ${f.hash}  ${f.firstLine}`),
    "",
    "Pass --today N and --goal N. Use the same N when one fence draws both states.",
    `For example: npm run viz -- ${command} ${id} --today 1 --goal 2`,
  ].join("\n");
}

// selectFences returns the Today fence and the Goal fence. One diagram fence
// pins both tiers, so the commands need no flags. With several fences the
// author must name both; the command never guesses which fence draws which
// state.
function selectFences(id: string, fences: Fence[], opts: Options): { today: Fence; goal: Fence } {
  if (fences.length === 0) {
    throw new Error(
      `${id}: the README has no plain-fence ASCII diagram with an arrow or box-drawing character. ` +
        `Add one in a \`\`\` or \`\`\`text block; the readme-diagram lint rule names the shape.`,
    );
  }
  const pick = (n: number, flag: string): Fence => {
    const fence = fences[n - 1];
    if (fence === undefined) {
      throw new Error(`${id}: ${flag} ${n} is out of range; the README has ${fences.length} diagram fence${fences.length === 1 ? "" : "s"}.`);
    }
    return fence;
  };

  if (fences.length === 1) {
    const only = fences[0]!;
    return {
      today: opts.today === undefined ? only : pick(opts.today, "--today"),
      goal: opts.goal === undefined ? only : pick(opts.goal, "--goal"),
    };
  }
  if (opts.today === undefined || opts.goal === undefined) {
    throw new Error(listing(opts.command, id, fences));
  }
  return { today: pick(opts.today, "--today"), goal: pick(opts.goal, "--goal") };
}

function pinLine(indent: string, today: string, goal: string): string {
  return `${indent}diagrams: { today: "${today}", goal: "${goal}" },`;
}

function replacePins(source: string, today: string, goal: string): string {
  const pattern = /^([ \t]*)diagrams\s*:\s*\{[^}]*\},?[ \t]*$/m;
  if (!pattern.test(source)) {
    throw new Error("the spec has no one-line `diagrams: { ... }` field to rewrite; restore the template shape");
  }
  return source.replace(pattern, (_line, indent: string) => pinLine(indent, today, goal));
}

function create(id: string, opts: Options): void {
  if (!/^\d/.test(id)) {
    throw new Error(`"${id}" must start with a digit; the registry glob reads specs/[0-9]*.ts`);
  }
  const file = join(specDir, `${id}.ts`);
  if (existsSync(file)) {
    throw new Error(`${file} already exists; run \`npm run viz -- pin ${id}\` to rewrite its pins`);
  }
  const { today, goal } = selectFences(id, diagramFences(readmeFor(id)), opts);

  let source = readFileSync(templateFile, "utf8");
  const exercise = 'exercise: "<exercise-id>"';
  if (!source.includes(exercise)) {
    throw new Error(`_template.ts no longer has ${exercise}; update the template and this command together`);
  }
  source = source.split(exercise).join(`exercise: "${id}"`);
  source = replacePins(source, today.hash, goal.hash);
  writeFileSync(file, source);
  console.log(`wrote web/src/viz/specs/${id}.ts (today ${today.hash}, goal ${goal.hash})`);
}

function pin(id: string, opts: Options): void {
  const file = join(specDir, `${id}.ts`);
  if (!existsSync(file)) {
    throw new Error(`no ${file}; run \`npm run viz -- new ${id}\` first`);
  }
  const source = readFileSync(file, "utf8");
  const { today, goal } = selectFences(id, diagramFences(readmeFor(id)), opts);
  const next = replacePins(source, today.hash, goal.hash);
  writeFileSync(file, next);
  console.log(`pinned web/src/viz/specs/${id}.ts (today ${today.hash}, goal ${goal.hash})`);
}

async function main(argv: string[]): Promise<void> {
  // Shots has its own parser and owns the process while Chrome runs.
  if (argv[0] === "shots") {
    await runShots(argv.slice(1));
    return;
  }
  const opts = parseArgs(argv);
  if (opts.command === "new") create(opts.id, opts);
  else pin(opts.id, opts);
}

// Keep the helpers importable for a check or a test without running a command.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`viz: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
