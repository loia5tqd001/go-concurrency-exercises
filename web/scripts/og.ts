// Renders og/card.html to public/og.png, the image link previews show.
//
// The card's exercise count and Go version come from src/generated/
// exercises.json — the same file the site builds from — so the picture cannot
// claim something the site does not do. Regenerate after adding an exercise:
//
//   npm run og
//
// Headless Chrome does the rendering, so this needs Chrome installed; the PNG
// is committed, so only the person changing the card runs it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1200;
const HEIGHT = 630;

// The exercise the card shows as open. Its row is highlighted, the five rows
// above it read as passed, and its test is the one the console reports.
const ACTIVE = "11-worker-pool";
const VISIBLE_ROWS = 6;

// How many boxes the difficulty bar draws, matching src/components/Sidebar.tsx.
const LEVELS: Record<string, number> = { "warm-up": 1, easy: 2, medium: 3, hard: 4, extreme: 5 };

interface Exercise {
  id: string;
  number: string;
  title: string;
  difficulty: string;
}

interface Site {
  goVersion: string;
  exercises: Exercise[];
}

const CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';

function row(e: Exercise, state: "active" | "passed" | ""): string {
  const bars = "<i></i>".repeat(LEVELS[e.difficulty] ?? 1);
  return [
    `<li class="${state}">`,
    `<span class="num">${e.number}<span class="diff diff-${e.difficulty}">${bars}</span></span>`,
    `<span class="title">${e.title}</span>`,
    state === "passed" ? `<span class="check">${CHECK}</span>` : "<span></span>",
    "</li>",
  ].join("");
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`no Chrome found; set CHROME=<path to a Chrome binary> and run again`);
  }
  return found;
}

// The PNG header carries the size at a fixed offset, so the check needs no
// image library. A wrong size means the layout overflowed, which a preview
// would crop rather than show.
function pngSize(file: string): [number, number] {
  const head = readFileSync(file).subarray(0, 24);
  if (head.toString("latin1", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

function screenshot(chrome: string, page: string, out: string, profile: string): void {
  // An earlier run's PNG would otherwise pass for this run's, so a broken
  // render would look like a success.
  rmSync(out, { force: true });
  // Chrome 132 dropped old headless and renamed the flag; try the modern
  // spelling first and fall back, so this works on either side of that.
  for (const headless of ["--headless=new", "--headless"]) {
    try {
      execFileSync(
        chrome,
        [
          headless,
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profile}`,
          "--force-device-scale-factor=1",
          `--window-size=${WIDTH},${HEIGHT}`,
          "--virtual-time-budget=3000",
          "--default-background-color=FFFFFFFF",
          `--screenshot=${out}`,
          pathToFileURL(page).href,
        ],
        { stdio: "ignore" },
      );
    } catch {
      // A non-zero exit still often writes the screenshot, so judge by the file.
    }
    if (existsSync(out)) return;
  }
  throw new Error(`Chrome wrote no screenshot; run it by hand: ${chrome} --headless=new --screenshot=${out} ${page}`);
}

const data = join(root, "src", "generated", "exercises.json");
if (!existsSync(data)) {
  throw new Error(`${data} is missing; run \`npm run prepare-data\` first`);
}
const site = JSON.parse(readFileSync(data, "utf8")) as Site;

const at = site.exercises.findIndex((e) => e.id === ACTIVE);
if (at < 0) throw new Error(`${ACTIVE} is not in exercises.json; update ACTIVE in scripts/og.ts`);
const first = Math.max(0, at - VISIBLE_ROWS + 1);
const rows = site.exercises
  .slice(first, at + 1)
  .map((e) => row(e, e.id === ACTIVE ? "active" : "passed"))
  .join("\n              ");

const template = readFileSync(join(root, "og", "card.html"), "utf8");
const html = template
  .replaceAll("{{COUNT}}", String(site.exercises.length))
  .replaceAll("{{GO_VERSION}}", site.goVersion)
  .replaceAll("{{ROWS}}", rows);

const cache = join(root, "node_modules", ".cache", "og");
rmSync(cache, { recursive: true, force: true });
mkdirSync(cache, { recursive: true });
const page = join(cache, "card.html");
writeFileSync(page, html);

const out = join(root, "public", "og.png");
screenshot(findChrome(), page, out, join(cache, "profile"));

const [w, h] = pngSize(out);
if (w !== WIDTH || h !== HEIGHT) throw new Error(`og.png is ${w}x${h}, want ${WIDTH}x${HEIGHT}`);
console.log(`og.png  ${w}x${h}  ${site.exercises.length} exercises  Go ${site.goVersion}`);
