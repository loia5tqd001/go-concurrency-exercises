// Main-thread side of the runner: one long-lived toolchain worker for
// builds, and a fresh runner worker for every program run.
import { useEffect, useState } from "react";
import type { BuildRequest, BuildResult, SourceFile } from "./toolchain.ts";

export type ToolchainState =
  | { phase: "loading"; loaded: number; total: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
}

class GoClient {
  state: ToolchainState = { phase: "loading", loaded: 0, total: 0 };
  private worker = new Worker(new URL("./toolchain.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(s: ToolchainState) => void>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "state") {
        this.setState(msg.state);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result as never);
    };
    this.worker.onerror = (e) => {
      this.setState({ phase: "error", message: e.message || "the toolchain worker failed to start" });
    };
  }

  subscribe(fn: (s: ToolchainState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  build(req: BuildRequest): Promise<BuildResult> {
    return this.call({ type: "build", req });
  }

  format(src: string): Promise<{ output?: string; error?: string }> {
    return this.call({ type: "format", src });
  }

  private setState(s: ToolchainState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private call<T>(msg: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }
}

let client: GoClient | undefined;

// goClient starts the toolchain download on first use.
export function goClient(): GoClient {
  return (client ??= new GoClient());
}

export function useToolchain(): ToolchainState {
  const [state, setState] = useState(() => goClient().state);
  useEffect(() => goClient().subscribe(setState), []);
  return state;
}

export interface RunHandle {
  exited: Promise<number | "stopped">;
  stop(): void;
}

export function runBinary(
  binary: Uint8Array,
  opts: { argv: string[]; dir: string; files: SourceFile[] },
  onOutput: (text: string, fd: 1 | 2) => void,
): RunHandle {
  const worker = new Worker(new URL("./runner.worker.ts", import.meta.url), { type: "module" });
  let settle!: (v: number | "stopped") => void;
  const exited = new Promise<number | "stopped">((resolve) => (settle = resolve));
  const finish = (v: number | "stopped") => {
    worker.terminate();
    settle(v);
  };

  worker.onmessage = (e: MessageEvent) => {
    if (e.data.type === "output") onOutput(e.data.text, e.data.fd);
    else if (e.data.type === "exit") finish(e.data.code);
  };
  worker.onerror = (e) => {
    onOutput(`runner failed: ${e.message}\n`, 2);
    finish(2);
  };
  worker.postMessage({ binary, ...opts }, [binary.buffer]);
  return { exited, stop: () => finish("stopped") };
}
