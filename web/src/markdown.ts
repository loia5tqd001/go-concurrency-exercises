// Renders the repository's Markdown (READMEs and solution write-ups) with
// links rewritten for the site: exercise folders become in-app routes, files
// of the open exercise open in the editor, and anything else goes to GitHub.
import { Marked } from "marked";
import { exerciseById, site } from "./data.ts";

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
        const l = (lang ?? "").split(/\s/)[0];
        return `<pre class="md-code"><code data-lang="${escapeHTML(l)}">${escapeHTML(text)}</code></pre>\n`;
      },
    },
  });
  return md.parse(src, { async: false });
}
