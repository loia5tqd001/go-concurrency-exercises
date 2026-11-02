// ConsoleModel writes program output straight into the DOM: a test run can
// print thousands of lines, which React state would re-render on every chunk.

export type LineKind = "cmd" | "pass" | "fail" | "dim" | "info" | "plain" | "err";

export interface ConsoleHooks {
  // onLocation fires when a file:line reference in the output is clicked.
  onLocation?: (file: string, line: number, col: number) => void;
  // onLine fires for every complete line of program output.
  onLine?: (text: string) => void;
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

  command(text: string): void {
    this.note(`$ ${text}`, "cmd");
  }

  note(text: string, kind: LineKind = "info"): void {
    this.endPartial();
    this.append(this.render(document.createElement("div"), text, kind));
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
    if (!a) return;
    this.hooks.onLocation?.(a.dataset.file!, Number(a.dataset.line), Number(a.dataset.col || 1));
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
    this.render(p.node, p.text, classify(p.text, p.fd));
    this.hooks.onLine?.(p.text);
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
