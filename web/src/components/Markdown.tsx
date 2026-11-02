import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { linesFromAttr, renderMarkdown, wrapCodeLines, type DocContext } from "../markdown.ts";
import { monaco } from "../monaco.ts";
import { navigate } from "../router.ts";
import { onThemeChange } from "../theme.ts";

interface Props {
  src: string;
  ctx: DocContext;
  onOpenFile?: (name: string) => void;
}

export function Markdown({ src, ctx, onOpenFile }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // One object per html string: React sets innerHTML again whenever this
  // prop's identity changes, which would wipe the colorized code blocks on
  // every unrelated re-render.
  const inner = useMemo(() => ({ __html: renderMarkdown(src, ctx) }), [src, ctx.dir, ctx.exerciseId]);
  const html = inner.__html;

  useEffect(() => {
    // Highlight Go blocks with the editor's own tokenizer, so code in the
    // docs looks exactly like code in the editor. The output's classes
    // belong to the current theme, so it is redone on every theme change.
    let live = true;
    // A fence that names lines is rebuilt as one block per line, so the named
    // lines can be banded. For Go that has to happen after colorize, which
    // replaces the whole markup.
    const paint = (code: HTMLElement, html: string) => {
      const hl = linesFromAttr(code.dataset.hl);
      code.innerHTML = hl.size ? wrapCodeLines(html, hl) : html;
    };
    const colorize = () => {
      for (const code of ref.current?.querySelectorAll<HTMLElement>('code[data-lang="go"]') ?? []) {
        code.dataset.src ??= code.textContent ?? "";
        monaco.editor.colorize(code.dataset.src, "go", { tabSize: 4 }).then((out) => {
          if (live) paint(code, out);
        });
      }
    };
    // Other languages are not colorized, so their markup is already final.
    for (const code of ref.current?.querySelectorAll<HTMLElement>('code[data-hl]:not([data-lang="go"])') ?? []) {
      paint(code, code.innerHTML);
    }
    colorize();
    const unsubscribe = onThemeChange(colorize);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [html]);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    if (a.hasAttribute("data-route")) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(a.getAttribute("href")!);
    } else if (a.dataset.file) {
      e.preventDefault();
      onOpenFile?.(a.dataset.file);
    }
  };

  return <div ref={ref} className="markdown" onClick={onClick} dangerouslySetInnerHTML={inner} />;
}
