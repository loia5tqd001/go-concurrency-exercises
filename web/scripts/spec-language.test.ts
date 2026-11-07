import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const specs = new URL("../src/viz/specs/", import.meta.url);
const files = readdirSync(specs).filter((name) => /^[0-9].*\.ts$/.test(name));
const hardWords =
  /\b(arbitrary|adversarial|cognitive|concomitant|consequently|constitute|demonstrate|facilitate|heuristic|invariant|nonetheless|quiescent|structurally|subsequently|utilize|whereas)\b/i;

function words(text: string): string[] {
  return text.replace(/\$\{[^}]+\}/g, " term ").trim().split(/\s+/).filter(Boolean);
}

function literal(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    return [
      expr.head.text,
      ...expr.templateSpans.flatMap((span) => [" term ", span.literal.text]),
    ].join("");
  }
  return undefined;
}

test("visualisation prose stays short and plain", () => {
  for (const file of files) {
    const source = readFileSync(new URL(file, specs), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ["summary", "insight", "say"].includes(node.name.text)) {
        const text = literal(node.initializer);
        if (text !== undefined) {
          assert.doesNotMatch(text, hardWords, `${file} uses a hard word in ${node.name.text}`);
          for (const sentence of text.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean)) {
            assert.ok(words(sentence).length <= 20, `${file} has a ${node.name.text} sentence over 20 words: ${sentence}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
});
