// FNV-1a 32-bit over a normalized README fence body. The site stamps a fence,
// the spec pins the stamp, and the checks compare them. One normalization and
// one hash, shared by both sides, is what makes a moved diagram keep its pin.
//
// Normalization: split on newlines, strip every carriage return and every
// trailing space or tab from each line, drop leading and trailing empty lines,
// join with "\n". Output: "fnv1a:" plus 8 lowercase hex digits.

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

export function normalizeDiagram(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/\r/g, "").replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function diagramHash(body: string): string {
  const bytes = new TextEncoder().encode(normalizeDiagram(body));
  let hash = OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    // Math.imul keeps the multiply in 32-bit space; >>> 0 makes it unsigned.
    hash = Math.imul(hash, PRIME) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}
