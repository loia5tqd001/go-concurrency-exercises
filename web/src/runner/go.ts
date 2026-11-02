// runGo runs one Go program built for GOOS=js against an in-memory
// filesystem, the way go_js_wasm_exec runs one under Node.
import "../generated/wasm_exec.js";
import { MemFS, processShim, type OutputHandler } from "./memfs.ts";

interface GoInstance {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  exited: boolean;
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
  _scheduledTimeouts: Map<number, unknown>;
  _pendingEvent: unknown;
  _resume(): void;
}

declare global {
  // Defined by wasm_exec.js.
  var Go: { new (): GoInstance };
}

export interface RunOptions {
  fs: MemFS;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  onOutput?: OutputHandler;
  // detectDeadlock makes the runtime report "all goroutines are asleep"
  // when the program is blocked with no timer left to wake it. Under Node,
  // go_js_wasm_exec gets this from the process exiting with an empty event
  // loop; a worker never exits, so we watch for the same condition.
  detectDeadlock?: boolean;
}

export interface Started {
  // exited resolves with the exit code.
  exited: Promise<number>;
}

// startGo starts the program and returns once its main has run up to the
// first point where it blocks or exits.
export async function startGo(module: WebAssembly.Module, opts: RunOptions): Promise<Started> {
  installGlobals(opts.fs);
  opts.fs.onOutput = opts.onOutput ?? (() => {});
  if (opts.cwd) opts.fs.chdir(opts.cwd);

  const go = new Go();
  go.argv = opts.argv;
  go.env = { HOME: "/home/gopher", TMPDIR: "/tmp", ...opts.env };
  let code = 0;
  go.exit = (c) => {
    code = c;
    // wasm_exec.js leaves the program's timers scheduled after exit, and
    // each one would throw "Go program has already exited" when it fires.
    for (const handle of go._scheduledTimeouts.values()) clearTimeout(handle as ReturnType<typeof setTimeout>);
    go._scheduledTimeouts.clear();
  };

  const instance = await WebAssembly.instantiate(module, go.importObject);
  let watchdog: ReturnType<typeof setInterval> | undefined;
  if (opts.detectDeadlock) {
    let idleTicks = 0;
    watchdog = setInterval(() => {
      // This only runs while Go has yielded to the event loop, so an empty
      // timer map means nothing will ever resume it.
      if (go.exited || go._scheduledTimeouts.size > 0) {
        idleTicks = 0;
        return;
      }
      if (++idleTicks < 2) return;
      clearInterval(watchdog);
      go._pendingEvent = { id: 0 };
      go._resume();
    }, 100);
  }

  const done = go.run(instance);
  return {
    exited: done.then(
      () => code,
      (err) => {
        opts.fs.onOutput(2, new TextEncoder().encode(`\n${err}\n`));
        return 2;
      },
    ).finally(() => clearInterval(watchdog)),
  };
}

export async function runGo(module: WebAssembly.Module, opts: RunOptions): Promise<number> {
  const started = await startGo(module, opts);
  return started.exited;
}

function installGlobals(fs: MemFS): void {
  const g = globalThis as Record<string, unknown>;
  g.fs = fs;
  const proc = g.process as { versions?: { node?: string }; cwd?: unknown; chdir?: unknown } | undefined;
  if (proc?.versions?.node) {
    // Under Node (the smoke test) keep the real process object and only
    // point its working directory at fs.
    proc.cwd = () => fs.cwd();
    proc.chdir = (dir: string) => fs.chdir(dir);
  } else {
    g.process = processShim(fs);
  }
}
