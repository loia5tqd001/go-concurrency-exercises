// Renders the repository's Markdown (READMEs and solution write-ups) with
// links rewritten for the site: exercise folders become in-app routes, files
// of the open exercise open in the editor, and anything else goes to GitHub.
import { Marked } from "marked";
import { exerciseById, site } from "./data.ts";
import { diagramHash } from "./viz/engine/diagramHash.ts";

export interface DocContext {
  // dir is the document's folder in the repository, e.g. "/" for the root
  // README, "/38-settle-once/" or "/solutions/".
  dir: string;
  // exerciseId and files identify the exercise open beside the document.
  exerciseId?: string;
  files?: string[];
}

const escapeHTML = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// slug follows GitHub's heading anchors, so "#the-bug" links keep working.
// GitHub slugs the rendered heading, so this takes rendered inline HTML and
// removes the markup first - otherwise the "_" of an emphasised word survives
// into the anchor and the link misses. Entities are decoded because the
// renderer escapes "&" and "'" before we ever see them.
const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function slug(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => entities[e]!)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function rewriteLink(href: string, ctx: DocContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return `href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"`;
  }
  if (href.startsWith("#")) return `href="${escapeHTML(href)}"`;

  const url = new URL(href, `https://repo${ctx.dir}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const [first, second] = parts;

  if (first && exerciseById.has(first) && (!second || second === "README.md")) {
    return `href="/${first}${url.hash}" data-route`;
  }
  if (first === "solutions" && second?.endsWith(".md") && exerciseById.has(second.slice(0, -3))) {
    return `href="/${second.slice(0, -3)}/solution" data-route`;
  }
  if (first && first === ctx.exerciseId && second && ctx.files?.includes(second)) {
    return `href="#" data-file="${escapeHTML(second)}"`;
  }
  const gh = `${site.repoUrl}/blob/${site.commit}${url.pathname}${url.hash}`;
  return `href="${escapeHTML(gh)}" target="_blank" rel="noopener noreferrer"`;
}

export function renderMarkdown(src: string, ctx: DocContext): string {
  const seen = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const inline = this.parser.parseInline(tokens);
        let id = slug(inline);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n > 0) id += `-${n}`;
        return `<h${depth} id="${escapeHTML(id)}">${inline}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const t = title ? ` title="${escapeHTML(title)}"` : "";
        return `<a ${rewriteLink(href, ctx)}${t}>${this.parser.parseInline(tokens)}</a>`;
      },
      code({ text, lang }) {
        // A fence may name the lines that carry the idea: ```go {6,12,23}.
        // The numbers are 1-based and count from the first line of the block.
        // Markdown.tsx bands them once the block has been colorized.
        const [l = "", ...rest] = (lang ?? "").trim().split(/\s+/);
        const hl = fenceLines(rest.join(" "));
        const attr = hl.length ? ` data-hl="${hl.join(",")}"` : "";
        // A plain fence is the hand-drawn diagram, not a code sample. Its
        // normalized hash lets the visualisation door mount on the exact
        // fence a spec pinned (artist review section 2.6).
        const diagram = l === "" || l === "text" ? ` data-diagram="${diagramHash(text)}"` : "";
        // The wrapper is the copy button's positioning frame: the pre itself
        // scrolls sideways, so a button inside it would leave the view with
        // the code.
        return `<div class="md-code-wrap"><pre class="md-code"${diagram}><code data-lang="${escapeHTML(l)}"${attr}>${escapeHTML(text)}</code></pre><button class="md-copy" type="button">Copy</button></div>\n`;
      },
    },
  });
  return md.parse(src, { async: false });
}

// fenceLines reads the {…} that follows a fence's language. It accepts single
// lines and ranges, separated by commas or spaces: {6}, {6,12,23}, {6,12-14}.
function fenceLines(rest: string): number[] {
  const spec = rest.match(/\{([^}]*)\}/)?.[1];
  if (!spec) return [];
  const lines = new Set<number>();
  for (const part of spec.split(/[,\s]+/)) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) continue;
    const last = Number(range[2] ?? range[1]);
    for (let n = Number(range[1]); n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

// linesFromAttr reads back what the fence renderer wrote into data-hl.
export function linesFromAttr(attr: string | undefined): Set<number> {
  return new Set((attr ?? "").split(",").filter(Boolean).map(Number));
}

// wrapCodeLines puts every line of a colorized block in its own span, so the
// lines named by the fence can be banded and the rest can step back. The block
// is then laid out by those spans, so the <br> Monaco puts between lines is
// dropped, and one left over at the end does not become a blank last line.
// A span still open at a line break (a block comment, a raw string) is closed
// at the end of that line and reopened on the next, which keeps every line a
// well-formed fragment.
export function wrapCodeLines(html: string, hl: Set<number>): string {
  const tag = /<(\/?)([a-zA-Z][^>]*?)>/g;
  const open: string[] = [];
  const out: { html: string; text: string }[] = [];
  let cur = "";
  let text = "";
  let line = 1;
  let at = 0;

  const endLine = () => {
    const close = open
      .slice()
      .reverse()
      .map((t) => `</${/^<([a-zA-Z0-9]+)/.exec(t)![1]}>`)
      .join("");
    out.push({ html: `<span class="md-line${hl.has(line) ? " hl" : ""}">${cur}${close}</span>`, text });
    cur = open.join("");
    text = "";
    line++;
  };

  // Text carries a real newline only in a fence that was never colorized.
  const pushText = (chunk: string) => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) endLine();
      cur += parts[i]!;
      text += parts[i]!;
    }
  };

  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    pushText(html.slice(at, m.index));
    at = tag.lastIndex;
    const t = m[0];
    const name = m[2]!.split(/[\s/>]/, 1)[0]!.toLowerCase();
    if (m[1] === "/") {
      open.pop();
      cur += t;
    } else if (name === "br") {
      endLine();
    } else if (t.endsWith("/>")) {
      cur += t;
    } else {
      open.push(t);
      cur += t;
    }
  }
  pushText(html.slice(at));
  out.push({ html: `<span class="md-line${hl.has(line) ? " hl" : ""}">${cur}</span>`, text });

  while (out.length > 1 && out[out.length - 1]!.text === "") out.pop();
  return out.map((l) => l.html).join("");
}
