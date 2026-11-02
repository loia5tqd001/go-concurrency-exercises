import { useEffect, useState } from "react";
import { monaco } from "./monaco.ts";
import { loadPref, savePref } from "./storage.ts";

export type ThemePref = "system" | "light" | "dark";

const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function effective(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return media.matches ? "dark" : "light";
}

function savedPref(): ThemePref {
  const saved = loadPref("theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

function apply(pref: ThemePref): void {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  monaco.editor.setTheme(effective(pref) === "dark" ? "vs-dark" : "vs");
  for (const fn of listeners) fn();
}

// onThemeChange notifies code that bakes theme colors into HTML, such as
// colorized Markdown code blocks.
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Apply before the first render: Monaco needs a theme before anything is
// colorized, and child effects run before the App's own effects.
apply(savedPref());

export function useTheme(): { pref: ThemePref; cycle: () => void } {
  const [pref, setPref] = useState<ThemePref>(savedPref);

  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const cycle = () => {
    const next: ThemePref = pref === "system" ? "light" : pref === "light" ? "dark" : "system";
    savePref("theme", next);
    setPref(next);
  };
  return { pref, cycle };
}
