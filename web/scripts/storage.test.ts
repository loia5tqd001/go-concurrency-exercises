import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { hash, loadCode, loadStatus, saveCode, saveStatus } from "../src/storage.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();

function installStorage(value: Storage): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  storage.clear();
  installStorage(storage);
});

test("existing progress loads through the stable public key", () => {
  storage.setItem("gce:v1:status:08-pipeline", "passed");
  assert.equal(loadStatus("08-pipeline"), "passed");
});

test("status is keyed by exercise id, not commit or scaffold content", () => {
  saveStatus("08-pipeline", "passed");
  saveCode("08-pipeline", "func main() {}", "old scaffold");
  saveCode("08-pipeline", "func main() { println() }", "new scaffold");

  assert.equal(storage.getItem("gce:v1:status:08-pipeline"), "passed");
  assert.equal(loadStatus("08-pipeline"), "passed");
});

test("adding or removing other exercises does not touch a saved status", () => {
  saveStatus("08-pipeline", "passed");
  saveStatus("new-exercise", "failed");
  saveStatus("removed-exercise", null);

  assert.equal(loadStatus("08-pipeline"), "passed");
  assert.equal(loadStatus("new-exercise"), "failed");
  assert.equal(loadStatus("removed-exercise"), null);
});

test("saved code keeps its scaffold base so the app can show the stale banner", () => {
  const oldScaffold = "package main\n\nfunc main() {}\n";
  const solution = "package main\n\nfunc main() { println(\"saved\") }\n";
  saveCode("08-pipeline", solution, oldScaffold);

  const saved = loadCode("08-pipeline");
  assert.equal(saved?.code, solution);
  assert.equal(saved?.base, hash(oldScaffold));
  assert.notEqual(saved?.base, hash("package main\n"));
});

test("returning code to the scaffold clears only the saved code", () => {
  const scaffold = "package main\n";
  saveStatus("08-pipeline", "passed");
  saveCode("08-pipeline", "package main\n\nfunc main() {}\n", scaffold);
  saveCode("08-pipeline", scaffold, scaffold);

  assert.equal(loadCode("08-pipeline"), null);
  assert.equal(loadStatus("08-pipeline"), "passed");
});

test("unknown values and corrupt JSON are ignored", () => {
  storage.setItem("gce:v1:status:08-pipeline", "finished");
  storage.setItem("gce:v1:code:08-pipeline", "{not json");
  assert.equal(loadStatus("08-pipeline"), null);
  assert.equal(loadCode("08-pipeline"), null);
});

test("blocked storage does not break loading, saving, or clearing", () => {
  installStorage({
    get length(): number {
      throw new Error("blocked");
    },
    clear: () => {
      throw new Error("blocked");
    },
    getItem: () => {
      throw new Error("blocked");
    },
    key: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });

  assert.doesNotThrow(() => loadStatus("08-pipeline"));
  assert.doesNotThrow(() => saveStatus("08-pipeline", "passed"));
  assert.doesNotThrow(() => saveCode("08-pipeline", "solution", "scaffold"));
  assert.equal(loadCode("08-pipeline"), null);
});
