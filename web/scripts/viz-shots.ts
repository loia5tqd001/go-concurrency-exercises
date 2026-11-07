// Pixel check for the visualiser: every scene's last frame, at a narrow pane
// (300 px, where the graph turns top to bottom) and a common one (640 px), in
// light and dark. It asserts what a learner would notice: no horizontal
// overflow of the figure or the page, no truncated label in the graph, and
// every control at least 32 x 32 px.
//
//   npm run viz -- shots [id ...] [--widths 300,640] [--themes light,dark] [--out DIR]
//
// A Vite server on :5173 and a Chrome DevTools endpoint on :9222 are reused
// when present. Otherwise the command starts a headless Chrome (and Vite when
// it is not up) and stops only what it started, so no manual CDP setup is
// needed. PNGs land under node_modules/.cache/viz-shots, which git ignores.
//
// The command seeks each scene to several points and checks each, because an
// overflow can appear at one moment only, then saves the last frame. Chrome
// runs with reduced motion, so the player does not autoplay.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(web, "src", "viz", "specs");
const cache = join(web, "node_modules", ".cache", "viz-shots");

const DEV_URL = (process.env.VIZ_SHOTS_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const CDP_URL = (process.env.VIZ_SHOTS_CDP ?? "http://localhost:9222").replace(/\/+$/, "");

const CONTROL_MIN = 32;

interface ShotsOptions {
  help: boolean;
  ids: string[];
  widths: number[];
  themes: ("light" | "dark")[];
  out: string;
}

interface SpecRef {
  // The exercise id: the spec's `exercise` field and the route.
  id: string;
  file: string;
}

function shotsUsage(): string {
  return [
    "usage: npm run viz -- shots [id ...] [--widths 300,640] [--themes light,dark] [--out DIR]",
    "",
    "id       an exercise id or its leading number (06 or 06-fan-out-fan-in);",
    "         every spec when omitted",
    "widths   figure widths to render (default 300,640)",
    "themes   light, dark, or both (default light,dark)",
    "out      PNG directory (default node_modules/.cache/viz-shots)",
    "",
    "The last frame of every Problem and Solution scene is saved. The command",
    "fails on horizontal overflow, a truncated label in the graph, or a",
    "control under 32 x 32 px.",
    "",
    "For the review frames of one spec:",
    "  npm run viz -- shots 06 --themes light",
  ].join("\n");
}

function commaList(value: string, flag: string): string[] {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`${flag} needs at least one value\n\n${shotsUsage()}`);
  return parts;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parseShotsArgs(argv: string[]): ShotsOptions {
  const options: ShotsOptions = {
    help: false,
    ids: [],
    widths: [300, 640],
    themes: ["light", "dark"],
    out: cache,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (flag: string): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value\n\n${shotsUsage()}`);
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--widths" || arg.startsWith("--widths=")) {
      const raw = arg === "--widths" ? value(arg) : arg.slice("--widths=".length);
      options.widths = unique(
        commaList(raw, "--widths").map((part) => {
          if (!/^\d+$/.test(part)) throw new Error(`--widths: "${part}" is not a width`);
          return Number(part);
        }),
      );
    } else if (arg === "--themes" || arg.startsWith("--themes=")) {
      const raw = arg === "--themes" ? value(arg) : arg.slice("--themes=".length);
      options.themes = unique(
        commaList(raw, "--themes").map((part) => {
          if (part !== "light" && part !== "dark") throw new Error(`--themes: "${part}" is not light or dark`);
          return part;
        }),
      );
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      options.out = resolve(arg === "--out" ? value(arg) : arg.slice("--out=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument "${arg}"\n\n${shotsUsage()}`);
    } else {
      options.ids.push(arg);
    }
  }
  if (!options.help) {
    if (options.widths.length === 0) throw new Error("--widths is empty");
    if (options.themes.length === 0) throw new Error("--themes is empty");
  }
  return options;
}

// The registry is a glob over specs/[0-9]*.ts, so the folder is the source of
// truth. The exercise field names the route; the file name is not always the
// same string.
function discoverSpecs(): SpecRef[] {
  const specs = readdirSync(specDir)
    .filter((name) => /^\d.*\.ts$/.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(join(specDir, name), "utf8");
      const match = /^\s*exercise:\s*"([^"]+)"/m.exec(source);
      if (match === null) throw new Error(`${name}: no exercise field`);
      return { id: match[1]!, file: name };
    });
  if (specs.length === 0) throw new Error(`no numbered specs in ${specDir}`);
  return specs;
}

function selectSpecs(specs: SpecRef[], wanted: string[]): SpecRef[] {
  if (wanted.length === 0) return specs;
  const picked: SpecRef[] = [];
  for (const token of wanted) {
    const matches = specs.filter((spec) => spec.id === token || spec.id.startsWith(`${token}-`));
    if (matches.length === 0) {
      throw new Error(`no spec matches "${token}"; known specs: ${specs.map((spec) => spec.id).join(", ")}`);
    }
    if (matches.length > 1) {
      throw new Error(`"${token}" matches ${matches.map((spec) => spec.id).join(", ")}; use the full id`);
    }
    if (!picked.includes(matches[0]!)) picked.push(matches[0]!);
  }
  return picked;
}

function generatedExerciseIds(): Set<string> {
  const file = join(web, "src", "generated", "exercises.json");
  if (!existsSync(file)) throw new Error(`${file} is missing; run \`npm run prepare-data\` first`);
  const index = JSON.parse(readFileSync(file, "utf8")) as { exercises?: { id?: unknown }[] };
  return new Set(
    (index.exercises ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])),
  );
}

// ---------------------------------------------------------------------------
// Processes and endpoints
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // The child was spawned detached, so the group catches Vite's helpers.
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else child.kill();
  } catch {
    child.kill();
  }
}

async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Service {
  url: string;
  reused: boolean;
  stop: () => void;
}

async function ensureDevServer(): Promise<Service> {
  if (await httpOk(`${DEV_URL}/`, 1500)) {
    return { url: DEV_URL, reused: true, stop: () => {} };
  }
  if (!existsSync(join(web, "src", "generated", "exercises.json"))) {
    console.log("shots: no generated exercise data; running prepare-data (this needs Go)");
    const prepared = spawnSync("bash", ["scripts/prepare.sh"], { cwd: web, stdio: "inherit" });
    if (prepared.status !== 0) {
      throw new Error("prepare-data failed; run `npm run prepare-data` and retry");
    }
  }
  const bin = join(web, "node_modules", ".bin", "vite");
  if (!existsSync(bin)) throw new Error(`${bin} is missing; run \`npm install\` in web/`);
  const port = new URL(`${DEV_URL}/`).port || "5173";
  const child = spawn(bin, ["--port", port, "--strictPort"], {
    cwd: web,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await httpOk(`${DEV_URL}/`, 1000)) {
      return { url: DEV_URL, reused: false, stop: () => killTree(child) };
    }
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}\n${log}`);
    await sleep(250);
  }
  killTree(child);
  throw new Error(`vite did not answer on ${DEV_URL}/\n${log}`);
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error("no Chrome found; set CHROME=<path to a Chrome binary> and retry");
  return found;
}

interface Browser {
  wsUrl: string;
  reused: boolean;
  stop: () => void;
}

function devtoolsLine(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let log = "";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const finish = (value: string | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match !== null) finish(match[1]!);
    });
    child.once("exit", () => finish(null));
  });
}

async function ensureChrome(): Promise<Browser> {
  const version = (await getJson(`${CDP_URL}/json/version`, 1200)) as
    | { webSocketDebuggerUrl?: unknown }
    | null;
  if (version !== null && typeof version.webSocketDebuggerUrl === "string") {
    return { wsUrl: version.webSocketDebuggerUrl, reused: true, stop: () => {} };
  }

  const chrome = findChrome();
  mkdirSync(cache, { recursive: true });
  const profile = join(cache, "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  // Chrome 132 renamed old headless; try the modern flag first, then fall
  // back, so either side of that change works.
  for (const headless of ["--headless=new", "--headless"]) {
    const child = spawn(
      chrome,
      [
        headless,
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--force-device-scale-factor=1",
        "--window-size=1440,1100",
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" },
    );
    const wsUrl = await devtoolsLine(child, 15_000);
    if (wsUrl !== null) return { wsUrl, reused: false, stop: () => killTree(child) };
    killTree(child);
  }
  throw new Error(`Chrome did not open a DevTools endpoint; set CHROME=<path to a Chrome binary>`);
}

// ---------------------------------------------------------------------------
// DevTools Protocol
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CdpClient {
  private socket: WebSocket;
  private ready: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, Pending>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "CDP error"));
      else pending.resolve(message.result);
    };
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.ready;
    const id = ++this.sequence;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface Page {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<void>;
  waitFor: (expression: string, what: string, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

function openPage(client: CdpClient, targetId: string, sessionId: string): Page {
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    client.send<T>(method, params, sessionId);

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await send<{
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails !== undefined) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new Error(detail ?? "page script failed");
    }
    return response.result.value as T;
  };

  const waitFor = async (expression: string, what: string, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate<boolean>(expression)) return;
      } catch {
        // A navigation destroys the execution context; the next poll retries.
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  return {
    send,
    evaluate,
    waitFor,
    async navigate(url: string): Promise<void> {
      const path = new URL(url).pathname;
      await send("Page.navigate", { url });
      await waitFor(
        `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`,
        `page ${url}`,
      );
    },
    async close(): Promise<void> {
      await client.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Page preparation
// ---------------------------------------------------------------------------

async function preparePage(page: Page): Promise<void> {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // A classic scrollbar would take 15 px from the pane and break the width
  // calibration. The review measured with it hidden.
  await page.send("Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
}

async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate<boolean>(
    `new Promise((resolve) => { let n = ${count}; const tick = () => (--n <= 0 ? resolve(true) : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`,
  );
}

// The doc pane's column is a percentage of the viewport, with a 260 px minimum.
// Setting the CSS variable in px lets the figure be exactly the review width:
// the doc body adds 44 px of horizontal padding, which is measured rather than
// hard-coded so a padding change cannot silently resize the frame.
async function setWidth(page: Page, width: number): Promise<void> {
  const applied = await page.evaluate<boolean>(`(() => {
    const workspace = document.querySelector(".workspace");
    const body = document.querySelector(".doc-body");
    const pane = document.querySelector(".doc-pane");
    if (workspace === null || body === null || pane === null) return false;
    workspace.style.setProperty("--doc-frac", "400px");
    const style = getComputedStyle(body);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const content = body.clientWidth - pad;
    const delta = pane.getBoundingClientRect().width - content;
    workspace.style.setProperty("--doc-frac", (${width} + delta) + "px");
    return true;
  })()`);
  if (!applied) throw new Error("the workspace or doc pane is missing");
  await frames(page, 2);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate<boolean>(
    `localStorage.setItem("gce:v1:pref:theme", ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`,
  );
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await frames(page, 1);
}


// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Measurement {
  figureOverflow: number;
  pageOverflow: number;
  truncated: string[];
  small: string[];
  height: number;
}

// Runs in the page against one figure element.
function measureScript(root: string): string {
  return `(() => {
    const fig = ${root};
    if (fig === null) return null;
    const body = document.querySelector(".doc-body");
    const truncated = [...fig.querySelectorAll("svg text")]
      .map((t) => t.textContent ?? "")
      .filter((t) => t.endsWith("…"));
    const small = [];
    for (const el of fig.querySelectorAll("button, summary, input")) {
      if (el.closest(".sim-log ol") !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const wide = el.matches("input[type=range]");
      if (r.height < ${CONTROL_MIN} - 10 || (!wide && (r.height < ${CONTROL_MIN} || r.width < ${CONTROL_MIN}))) {
        small.push((el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 30) + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    }
    return {
      figureOverflow: fig.scrollWidth - fig.clientWidth,
      pageOverflow: body === null ? 0 : body.scrollWidth - body.clientWidth,
      truncated,
      small,
      height: Math.round(fig.getBoundingClientRect().height),
    };
  })()`;
}

class Report {
  failures = new Set<string>();
  pngs: string[] = [];
  fail(message: string): void {
    this.failures.add(message);
  }
}

function check(where: string, m: Measurement | null, report: Report): void {
  if (m === null) {
    report.fail(`${where}: the figure is missing`);
    return;
  }
  if (m.figureOverflow > 1) report.fail(`${where}: the figure overflows sideways by ${m.figureOverflow} px`);
  if (m.pageOverflow > 1) report.fail(`${where}: the page scrolls sideways by ${m.pageOverflow} px`);
  for (const text of m.truncated) report.fail(`${where}: the graph truncates "${text}"; shorten the label`);
  for (const control of m.small) report.fail(`${where}: control under ${CONTROL_MIN} px: ${control}`);
}

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function seek(page: Page, root: string, fraction: number): Promise<void> {
  await page.evaluate<boolean>(`(() => {
    const fig = ${root};
    const play = fig.querySelector(".sim-play");
    if (play !== null && play.getAttribute("aria-label") === "Pause") play.click();
    const range = fig.querySelector(".sim-scrub input");
    const value = Math.round(Number(range.max) * ${fraction});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(range, String(value));
    range.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await frames(page, 3);
}

async function capture(page: Page, root: string, file: string, report: Report): Promise<void> {
  const rect = await page.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
    const fig = ${root};
    if (fig === null) return null;
    fig.scrollIntoView({ block: "start" });
    const r = fig.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  if (rect === null) return;
  await frames(page, 2);
  const shot = await page.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: { x: Math.max(0, rect.x - 4), y: Math.max(0, rect.y - 4), width: rect.w + 8, height: Math.min(rect.h + 8, 2400), scale: 1 },
  });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  report.pngs.push(file);
}

const POSITIONS = [0, 0.25, 0.5, 0.75, 1];

// Motion check. Still frames cannot show jank, so play the scene in real
// time (motion allowed) and sample every animation frame:
//  - the scrubber's thumb must sit where playback is: a range input snaps to
//    its `step`, which makes the thumb and fill jump while time runs smoothly;
//  - no frame may take over 34 ms (a dropped frame at 60 Hz).
// The pane runs with reduced motion for the still frames, so the check turns
// it off for a moment and back on.
async function smoothness(page: Page, root: string, where: string, report: Report): Promise<void> {
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  try {
    // The player learns of the new setting through a media-query event.
    await frames(page, 8);
    await page.evaluate<boolean>(`(() => {
      const fig = ${root};
      fig.querySelector("[aria-label=Restart]").click();
      return true;
    })()`);
    await frames(page, 4);
    const running = await page.evaluate<boolean>(`${root}.querySelector(".sim-play").textContent.includes("Pause")`);
    if (!running) {
      // A scene that opens paused at its first caption still plays on a click.
      await page.evaluate<boolean>(`(${root}.querySelector(".sim-play").click(), true)`);
      await frames(page, 3);
    }
    const result = await page.evaluate<{ frames: number; worstDrift: number; slow: number; worstFrame: number; moved: boolean } | null>(`new Promise((resolve) => {
      const fig = ${root};
      const range = fig.querySelector(".sim-scrub input");
      if (range === null) { resolve(null); return; }
      let last = performance.now(), n = 0, worstDrift = 0, slow = 0, worstFrame = 0;
      const start = Number(range.value);
      const tick = (now) => {
        const dt = now - last; last = now;
        if (n > 2) { slow += dt > 34 ? 1 : 0; worstFrame = Math.max(worstFrame, dt); }
        // value is what the browser drew; the style variable is what playback asked for.
        const asked = parseFloat(range.style.getPropertyValue("--sim-pos"));
        const drawn = (Number(range.value) / Number(range.max)) * 100;
        if (!Number.isNaN(asked)) worstDrift = Math.max(worstDrift, Math.abs(asked - drawn));
        if (++n < 45) requestAnimationFrame(tick);
        else resolve({ frames: n, worstDrift, slow, worstFrame, moved: Number(range.value) !== start });
      };
      requestAnimationFrame(tick);
    })`);
    if (result === null) return;
    if (!result.moved) {
      report.fail(`${where}: playback did not move in 45 frames, so the motion check proved nothing`);
      return;
    }
    if (result.worstDrift > 0.2) {
      report.fail(`${where}: the scrubber thumb lags playback by ${result.worstDrift.toFixed(2)}% (a coarse range step makes it jump)`);
    }
    if (result.slow > 2) report.fail(`${where}: ${result.slow} frames took over 34 ms (worst ${Math.round(result.worstFrame)} ms)`);
  } finally {
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await frames(page, 2);
  }
}

async function sceneFrames(page: Page, root: string, where: string, file: string, report: Report): Promise<void> {
  await page.waitFor(`${root} !== null && ${root}.querySelector(".sim-scrub input") !== null`, where);
  for (const position of POSITIONS) {
    await seek(page, root, position);
    check(`${where} at ${Math.round(position * 100)}%`, await page.evaluate<Measurement | null>(measureScript(root)), report);
  }
  await capture(page, root, file, report);
  await smoothness(page, root, where, report);
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

interface RunContext {
  page: Page;
  base: string;
  out: string;
  report: Report;
}

async function problemScenes(context: RunContext, spec: SpecRef, width: number, theme: "light" | "dark"): Promise<void> {
  const { page, base, out, report } = context;
  await page.navigate(`${base}/${spec.id}`);
  await page.waitFor(`document.querySelector(".doc-body") !== null`, "the exercise page");
  await setTheme(page, theme);
  await setWidth(page, width);
  await page.waitFor(`document.querySelector(".viz-door .viz-chip") !== null`, "the README door");
  const doors = await page.evaluate<number>(`document.querySelectorAll(".viz-door").length`);
  for (let door = 0; door < doors; door++) {
    const chips = await page.evaluate<string[]>(
      `[...document.querySelectorAll(".viz-door")[${door}].querySelectorAll(".viz-chip")].map((c) => c.textContent.trim())`,
    );
    for (const [index, label] of chips.entries()) {
      if (label === "Diagram") continue;
      await page.evaluate<boolean>(`(document.querySelectorAll(".viz-door")[${door}].querySelectorAll(".viz-chip")[${index}].click(), true)`);
      const root = `document.querySelectorAll(".viz-door")[${door}].querySelector(".sim")`;
      const scene = slug(label);
      await sceneFrames(page, root, `${spec.id}/${scene} at ${width} px ${theme}`, join(out, `${spec.id}__${scene}__${width}__${theme}.png`), report);
    }
  }
}

async function solutionScenes(context: RunContext, spec: SpecRef, width: number, theme: "light" | "dark"): Promise<void> {
  const { page, base, out, report } = context;
  await page.navigate(`${base}/${spec.id}/solution`);
  await page.waitFor(`document.querySelector(".doc-body") !== null`, "the solution page");
  await setTheme(page, theme);
  await setWidth(page, width);
  await page.evaluate<boolean>(`(() => { document.querySelector(".spoiler button")?.click(); return true; })()`);
  await frames(page, 4);
  const root = `document.querySelector(".viz-solution .sim")`;
  if (!(await page.evaluate<boolean>(`${root} !== null`))) return;
  const chips = await page.evaluate<string[]>(`[...${root}.querySelectorAll(".sim-chip")].map((c) => c.textContent.trim())`);
  const labels = chips.length === 0 ? ["inside"] : chips;
  for (const [index, label] of labels.entries()) {
    if (chips.length > 0) await page.evaluate<boolean>(`(${root}.querySelectorAll(".sim-chip")[${index}].click(), true)`);
    const scene = slug(label);
    await sceneFrames(page, root, `${spec.id}/${scene} at ${width} px ${theme}`, join(out, `${spec.id}__${scene}__${width}__${theme}.png`), report);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runShots(argv: string[]): Promise<void> {
  const options = parseShotsArgs(argv);
  if (options.help) {
    console.log(shotsUsage());
    return;
  }
  const specs = selectSpecs(discoverSpecs(), options.ids);
  const exercises = generatedExerciseIds();
  for (const spec of specs) {
    if (!exercises.has(spec.id)) {
      throw new Error(`${spec.file} names ${spec.id}, which is not in src/generated/exercises.json; run \`npm run prepare-data\``);
    }
  }
  mkdirSync(options.out, { recursive: true });
  const dev = await ensureDevServer();
  let chrome: Browser;
  try {
    chrome = await ensureChrome();
  } catch (error) {
    // Do not leave the Vite process this command started running.
    dev.stop();
    throw error;
  }
  console.log(`shots  vite ${dev.url} (${dev.reused ? "reused" : "started"})`);
  console.log(`shots  chrome ${chrome.reused ? "reused on :9222" : "started headless"}`);

  const client = new CdpClient(chrome.wsUrl);
  let page: Page | null = null;
  try {
    const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    page = openPage(client, created.targetId, attached.sessionId);
    await preparePage(page);
    const report = new Report();
    const context: RunContext = { page, base: dev.url, out: options.out, report };
    for (const spec of specs) {
      console.log(`shots  ${spec.id}`);
      for (const theme of options.themes) {
        for (const width of options.widths) {
          try {
            await problemScenes(context, spec, width, theme);
            await solutionScenes(context, spec, width, theme);
          } catch (error) {
            report.fail(`${spec.id} at ${width} px ${theme}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    for (const failure of [...report.failures].sort()) console.log(`FAIL  ${failure}`);
    console.log(`\nshots  ${specs.length} spec(s), ${report.pngs.length} PNGs, ${report.failures.size} failure(s)`);
    console.log(`shots  PNGs in ${options.out}`);
    if (report.failures.size > 0) process.exitCode = 1;
  } finally {
    if (page !== null) await page.close();
    client.close();
    chrome.stop();
    dev.stop();
  }
}
