// ConsoleModel writes program output straight into the DOM: a test run can
// print thousands of lines, which React state would re-render on every chunk.

export type LineKind = "cmd" | "pass" | "fail" | "dim" | "info" | "plain" | "err";

// A link the console draws beside a line. The link is a real anchor, so
// mouse and keyboard (Tab, Enter) reach it without extra keys.
export interface ConsoleAction {
  label: string;
  run: () => void;
}

export interface ConsoleHooks {
  // onLocation fires when a file:line reference in the output is clicked.
  onLocation?: (file: string, line: number, col: number) => void;
  // onLine fires for every complete line of program output.
  onLine?: (text: string) => void;
  // seeWhy returns the action for a failing test the spec names, or null.
  // Decision 5: the console then shows "See why ▸" beside that line.
  seeWhy?: (test: string) => (() => void) | null;
}

// Matches "main.go:12", "./main.go:12:5" and the absolute paths in panics.
const locationRe = /(?:[\w.-]*\/)*([\w.-]+\.go):(\d+)(?::(\d+))?/g;
const maxLines = 20000;

function classify(text: string, fd: 1 | 2): LineKind {
  if (/^\s*--- FAIL|^FAIL\b|^panic: |^fatal error: /.test(text)) return "fail";
  if (/^\s*--- PASS|^PASS$|^ok\s/.test(text)) return "pass";
  if (/^=== (RUN|PAUSE|CONT|NAME)|^\s*--- SKIP/.test(text)) return "dim";
  return fd === 2 ? "err" : "plain";
}

export class ConsoleModel {
  files = new Set<string>();
  hooks: ConsoleHooks = {};
  private el: HTMLElement | null = null;
  private partial: { node: HTMLElement; text: string; fd: 1 | 2 } | null = null;

  attach = (el: HTMLElement | null) => {
    this.el = el;
  };

  clear(): void {
    if (this.el) this.el.textContent = "";
    this.partial = null;
  }

  // empty lets the caller write a greeting only while no run has printed.
  get empty(): boolean {
    return this.el === null || this.el.childElementCount === 0;
  }

  command(text: string): void {
    this.note(`$ ${text}`, "cmd");
  }

  note(text: string, kind: LineKind = "info", action?: ConsoleAction): void {
    this.endPartial();
    const node = this.render(document.createElement("div"), text, kind);
    if (action) node.append(" ", this.actionLink(action.label, action.run));
    this.append(node);
  }

  write(text: string, fd: 1 | 2): void {
    const parts = text.split("\n");
    parts.forEach((chunk, i) => {
      if (i < parts.length - 1) {
        this.extendPartial(chunk, fd);
        this.endPartial();
      } else if (chunk) {
        this.extendPartial(chunk, fd);
      }
    });
  }

  handleClick(target: EventTarget | null): void {
    const a = (target as HTMLElement | null)?.closest<HTMLAnchorElement>("a.loc");
    // The See why link also wears .loc for the console's link styling, but it
    // has no file to open.
    if (!a || a.dataset.file === undefined) return;
    this.hooks.onLocation?.(a.dataset.file, Number(a.dataset.line), Number(a.dataset.col || 1));
  }

  private extendPartial(chunk: string, fd: 1 | 2): void {
    if (!this.partial) {
      const node = document.createElement("div");
      this.partial = { node, text: "", fd };
      this.append(node);
    }
    this.partial.text += chunk;
    this.render(this.partial.node, this.partial.text, "plain");
  }

  private endPartial(): void {
    const p = this.partial;
    if (!p) return;
    this.partial = null;
    const kind = classify(p.text, p.fd);
    const node = this.render(p.node, p.text, kind);
    // A failing test line carries the full Go test name between "--- FAIL:"
    // and the duration. The spec decides whether that name earns a link.
    const test = kind === "fail" ? /^\s*--- FAIL: (\S+)/.exec(p.text)?.[1] : undefined;
    const run = test === undefined ? null : (this.hooks.seeWhy?.(test) ?? null);
    if (run !== null) node.append(" ", this.actionLink("See why ▸", run));
    this.hooks.onLine?.(p.text);
  }

  private actionLink(label: string, run: () => void): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = "loc see-why";
    a.href = "#";
    a.textContent = label;
    a.addEventListener("click", (event) => {
      event.preventDefault();
      run();
    });
    return a;
  }

  private render(node: HTMLElement, text: string, kind: LineKind): HTMLElement {
    node.className = `ln ${kind}`;
    node.textContent = "";
    let last = 0;
    for (const m of text.matchAll(locationRe)) {
      if (!this.files.has(m[1])) continue;
      node.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.className = "loc";
      a.textContent = m[0];
      a.dataset.file = m[1];
      a.dataset.line = m[2];
      if (m[3]) a.dataset.col = m[3];
      node.append(a);
      last = m.index + m[0].length;
    }
    node.append(text.slice(last) || (last === 0 ? "​" : ""));
    return node;
  }

  private append(node: HTMLElement): void {
    const el = this.el;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.append(node);
    while (el.childElementCount > maxLines) el.firstElementChild!.remove();
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}
