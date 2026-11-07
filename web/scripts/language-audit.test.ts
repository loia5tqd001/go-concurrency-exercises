import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditText, markdownFiles } from "./language-audit.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("all rendered Markdown stays short and plain", () => {
  for (const file of markdownFiles()) {
    const result = auditText(file, readFileSync(`${root}/${file}`, "utf8"));
    assert.equal(result.long, 0, `${file} has a sentence over 20 words`);
    assert.equal(result.hard, 0, `${file} uses hard filler`);
  }
});
