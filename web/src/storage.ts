// Per-browser progress and preferences. Every access is guarded: storage can
// be missing or throw (private windows, blocked site data), and the app must
// keep working without it.
const prefix = "gce:v1:";

function get(key: string): string | null {
  try {
    return localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, value);
  } catch {
    // Not persisting is acceptable; the session still works.
  }
}

// hash is FNV-1a; it only has to notice that a scaffold changed.
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export interface SavedCode {
  code: string;
  // base is the hash of the scaffold the code was written against, so a
  // changed exercise can be detected.
  base: string;
}

export function loadCode(id: string): SavedCode | null {
  const raw = get(`code:${id}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SavedCode;
    return typeof v.code === "string" ? v : null;
  } catch {
    return null;
  }
}

export function saveCode(id: string, code: string, scaffold: string): void {
  if (code === scaffold) set(`code:${id}`, null);
  else set(`code:${id}`, JSON.stringify({ code, base: hash(scaffold) }));
}

export function clearCode(id: string): void {
  set(`code:${id}`, null);
}

export type Status = "passed" | "failed";

export function loadStatus(id: string): Status | null {
  const v = get(`status:${id}`);
  return v === "passed" || v === "failed" ? v : null;
}

export function saveStatus(id: string, status: Status | null): void {
  set(`status:${id}`, status);
}

export function loadPref(key: string): string | null {
  return get(`pref:${key}`);
}

export function savePref(key: string, value: string): void {
  set(`pref:${key}`, value);
}
