// A browser-level guard for the exercise loading sequence. The exercise JSON
// request is held so the skeleton and loaded states can be measured in the
// same page. This catches drift that static tests cannot see.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TabBox {
  text: string;
  class: string;
  rect: Rect | null;
}

interface Frame {
  stage: "loading" | "loaded" | "none";
  tabbar: Rect | null;
  tabs: TabBox[];
  codeToolbar: Rect | null;
  docBody: Rect | null;
  editor: Rect | null;
  consoleToolbar: Rect | null;
  console: Rect | null;
  docPane: Rect | null;
  codePane: Rect | null;
}

const web = path.resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeBinary(): string {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("layout-check: Chrome not found; set CHROME_BIN");
  return found;
}

async function measure(route: string, width: number, preferredPort: number, checkProgress = false): Promise<Frame[]> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "exercise-layout-chrome-"));
  const debugPort = preferredPort + 400;
  const preview = spawn(
    path.join(web, "node_modules/.bin/vite"),
    ["preview", "--port", String(preferredPort), "--strictPort", "--host", "127.0.0.1"],
    { cwd: web, stdio: "ignore" },
  );
  const chromeArgs = [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},800`,
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (process.getuid?.() === 0) chromeArgs.push("--no-sandbox");
  const chrome = spawn(chromeBinary(), [...chromeArgs, "about:blank"], { stdio: "ignore" });

  let socket: WebSocket | undefined;
  try {
    let targets: { type: string; webSocketDebuggerUrl: string }[] | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
        targets = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
        if (targets.some((target) => target.type === "page")) break;
      } catch {
        // Chrome is still starting.
      }
      await sleep(200);
    }
    const page = targets?.find((target) => target.type === "page");
    if (!page) throw new Error("layout-check: Chrome page target did not start");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("layout-check: Chrome socket failed"));
    });

    let requestId = 0;
    const pending = new Map<number, (value: unknown) => void>();
    const held: string[] = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { requestId?: string };
      };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      if (message.method === "Fetch.requestPaused" && message.params?.requestId) held.push(message.params.requestId);
    };
    const send = (method: string, params: object = {}) =>
      new Promise<{ result: { result: { value: unknown } } }>((resolve) => {
        const id = ++requestId;
        pending.set(id, resolve as (value: unknown) => void);
        socket!.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression: string): Promise<unknown> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.result.result.value;
    };

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/data/*.json", requestStage: "Request" }] });

    const snapshot = `(() => {
      const box = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      };
      const query = (selector) => document.querySelector(selector);
      const tabs = query(".doc-tabs");
      return JSON.stringify({
        stage: query(".workspace-loading") ? "loading" : query(".doc-tabs") ? "loaded" : "none",
        tabbar: box(tabs),
        tabs: tabs
          ? [...tabs.children].map((element) => ({
              text: element.textContent.trim().slice(0, 20),
              class: element.className || element.tagName,
              rect: box(element),
            }))
          : [],
        codeToolbar: box(query(".code-toolbar")),
        docBody: box(query(".doc-body")),
        editor: box(query(".editor-host")),
        consoleToolbar: box(query(".console-toolbar")),
        console: box(query(".console")),
        docPane: box(query(".doc-pane")),
        codePane: box(query(".code-pane")),
      });
    })()`;
    const readFrame = async (): Promise<Frame> => JSON.parse(String(await evaluate(snapshot))) as Frame;

    await sleep(1200);
    await send("Page.navigate", { url: `http://127.0.0.1:${preferredPort}${route}` });
    for (let attempt = 0; attempt < 50 && held.length === 0; attempt++) await sleep(100);
    if (held.length === 0) throw new Error(`layout-check: ${route} did not request exercise data`);
    await sleep(500);
    const loading = await readFrame();

    for (const id of held) await send("Fetch.continueRequest", { requestId: id });
    await send("Fetch.disable");
    for (let attempt = 0; attempt < 100; attempt++) {
      const stage = await evaluate(`document.querySelector(".workspace:not(.workspace-loading)") !== null`);
      if (stage === true) break;
      await sleep(100);
    }
    await sleep(500);
    const loaded = await readFrame();

    if (checkProgress) {
      const status = JSON.stringify("passed");
      const saved = JSON.stringify(
        JSON.stringify({
          code: "package main\n\nfunc main() {}\n",
          base: "old-scaffold",
        }),
      );
      await evaluate(`localStorage.setItem("gce:v1:status:08-pipeline", ${status}); localStorage.setItem("gce:v1:code:08-pipeline", ${saved}); true`);
      await send("Page.reload", { ignoreCache: true });
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await evaluate(`document.querySelector(".workspace:not(.workspace-loading)") !== null`);
        if (ready === true) break;
        await sleep(100);
      }
      await sleep(500);
      const progress = JSON.parse(
        String(
          await evaluate(`JSON.stringify({
            sidebar: document.querySelector(".sidebar-foot span")?.textContent.replace(/\\s+/g, " ").trim() ?? "",
            docPassed: document.querySelector(".doc-tabs .badge.pass") !== null,
            rowPassed: document.querySelector('.ex-list a[href="/08-pipeline"] .ex-status.pass') !== null,
            stale: [...document.querySelectorAll(".banner")].some((element) =>
              element.textContent.includes("This exercise changed since you saved your code.")
            ),
          })`),
        ),
      ) as { sidebar: string; docPassed: boolean; rowPassed: boolean; stale: boolean };
      if (
        !progress.sidebar.startsWith("1 of ") ||
        !progress.docPassed ||
        !progress.rowPassed ||
        !progress.stale
      ) {
        throw new Error(`layout-check: saved progress did not survive reload: ${JSON.stringify(progress)}`);
      }
    }
    return [loading, loaded];
  } finally {
    socket?.close();
    chrome.kill();
    preview.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function same(label: string, a: unknown, b: unknown): string[] {
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${label}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

function compareDesktop(route: string, [loading, loaded]: Frame[]): string[] {
  if (loading?.stage !== "loading" || loaded?.stage !== "loaded") {
    return [`${route}: stages ${loading?.stage} -> ${loaded?.stage}`];
  }
  const keys: (keyof Frame)[] = [
    "tabbar",
    "tabs",
    "codeToolbar",
    "docBody",
    "editor",
    "consoleToolbar",
    "console",
    "docPane",
    "codePane",
  ];
  return keys.flatMap((key) => same(`${route} ${key}`, loading[key], loaded[key]));
}

function compareNarrow(route: string, [loading, loaded]: Frame[]): string[] {
  if (loading?.stage !== "loading" || loaded?.stage !== "loaded") {
    return [`${route}: stages ${loading?.stage} -> ${loaded?.stage}`];
  }
  const visible = (rect: Rect | null) => (rect ? { x: rect.x, width: rect.width, y: rect.y } : null);
  return [
    ...same(`${route} tabbar`, loading.tabbar, loaded.tabbar),
    ...same(`${route} tabs`, loading.tabs, loaded.tabs),
    ...same(`${route} docPane top`, visible(loading.docPane), visible(loaded.docPane)),
    ...same(`${route} docBody top`, visible(loading.docBody), visible(loaded.docBody)),
    ...(loading.codePane?.height === 0 ? [] : [`${route} code pane is visible while loading`]),
    ...((loaded.codePane?.y ?? 0) >= 800 ? [] : [`${route} loaded code pane enters the first viewport`]),
  ];
}

async function main(): Promise<void> {
  const failures: string[] = [];
  for (const [index, route] of ["/00-limit-crawler", "/04-graceful-sigint", "/08-pipeline"].entries()) {
    failures.push(...compareDesktop(route, await measure(route, 1300, 4300 + index, route === "/08-pipeline")));
  }
  failures.push(...compareNarrow("/08-pipeline", await measure("/08-pipeline", 800, 4310)));
  failures.push(...compareNarrow("/08-pipeline", await measure("/08-pipeline", 500, 4311)));
  if (failures.length > 0) {
    console.error(`layout-check: ${failures.length} failure(s)`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("layout-check: loading geometry and saved progress are stable");
}

await main();
