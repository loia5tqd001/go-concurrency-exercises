// Main-thread side of the runner: one long-lived toolchain worker for
// builds, and a fresh runner worker for every program run.
import { useEffect, useState } from "react";
import type { BuildRequest, BuildResult, SourceFile } from "./toolchain.ts";

export type ToolchainState =
  | { phase: "idle" }
  | { phase: "loading"; loaded: number; total: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
}

class GoClient {
  state: ToolchainState = { phase: "idle" };
  private worker?: Worker;
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(s: ToolchainState) => void>();

  private start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.setState({ phase: "loading", loaded: 0, total: 0 });

    const worker = new Worker(new URL("./toolchain.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
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
    worker.onerror = (e) => {
      this.setState({ phase: "error", message: e.message || "the toolchain worker failed to start" });
    };
    return this.readyPromise;
  }

  subscribe(fn: (s: ToolchainState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    await this.start();
    return this.call({ type: "build", req });
  }

  async format(src: string): Promise<{ output?: string; error?: string }> {
    await this.start();
    return this.call({ type: "format", src });
  }

  private setState(s: ToolchainState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
    if (s.phase === "ready") {
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
    } else if (s.phase === "error") {
      this.rejectReady?.(new Error(s.message));
      this.resolveReady = undefined;
      this.rejectReady = undefined;
    }
  }

  private call<T>(msg: object): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("the toolchain worker is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      worker.postMessage({ ...msg, id });
    });
  }
}

let client: GoClient | undefined;

// goClient constructs the client without starting its worker.
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
