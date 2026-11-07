// Read the learner-facing Markdown outside fenced code and report prose that
// is likely too dense. This is a review tool, not an automatic rewriter.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const longSentence = 20;
const hardWords =
  /\b(arbitrary|adversarial|cognitive|concomitant|consequently|constitute|demonstrate|facilitate|heuristic|invariant|nonetheless|quiescent|structurally|subsequently|utilize|whereas)\b/gi;

interface Result {
  file: string;
  sentences: number;
  long: number;
  hard: number;
  words: number;
}

export function markdownFiles(): string[] {
  const exercises = readdirSync(root)
    .filter((name) => /^\d/.test(name) && statSync(join(root, name)).isDirectory())
    .map((name) => join(name, "README.md"))
    .filter((path) => {
      try {
        return statSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    });
  const solutions = readdirSync(join(root, "solutions"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("solutions", name));
  return ["README.md", ...exercises, ...solutions].sort();
}

export function auditText(file: string, source: string): Result {
  const prose = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]+`/g, "term")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(paragraph.join(" "));
    paragraph = [];
  };
  for (const raw of prose.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("|")) {
      flush();
      continue;
    }
    const item = /^(?:[*+-]|\d+\.)\s+(.*)$/.exec(line);
    if (item !== null) {
      flush();
      blocks.push(item[1]!);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  const body = blocks.join(". ");
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 20);
  const counts = sentences.map((sentence) => sentence.split(/\s+/).length);
  return {
    file,
    sentences: sentences.length,
    long: counts.filter((count) => count > longSentence).length,
    hard: (prose.match(hardWords) ?? []).length,
    words: counts.reduce((sum, count) => sum + count, 0),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = markdownFiles().map((file) => auditText(file, readFileSync(join(root, file), "utf8")));
  const total = results.reduce(
    (sum, row) => ({
      files: sum.files + 1,
      sentences: sum.sentences + row.sentences,
      long: sum.long + row.long,
      hard: sum.hard + row.hard,
      words: sum.words + row.words,
    }),
    { files: 0, sentences: 0, long: 0, hard: 0, words: 0 },
  );

  console.log(
    `${total.files} files, ${total.words} words, ${total.sentences} sentences, ` +
      `${total.long} over ${longSentence} words, ${total.hard} hard words`,
  );
  for (const row of results.sort((a, b) => b.long + b.hard * 2 - (a.long + a.hard * 2)).slice(0, 20)) {
    console.log(
      `${String(row.long).padStart(4)} long  ${String(row.hard).padStart(3)} hard  ` +
        `${String(row.words).padStart(6)} words  ${row.file}`,
    );
  }
}
