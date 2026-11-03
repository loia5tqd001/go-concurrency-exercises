// The star count comes from GitHub's public API, which allows 60
// unauthenticated requests an hour per IP address. One answer is kept for a
// day, so a visitor makes at most one request, and a rate-limited or offline
// visitor simply keeps the plain icon. None of this is worth showing an error
// for, so every failure path here is silent.
import { useEffect, useState } from "react";
import { site } from "./data.ts";

const KEY = "repo-stars";
const TTL = 24 * 60 * 60 * 1000;

function cached(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const held = JSON.parse(raw) as { at: number; stars: number };
    return Date.now() - held.at < TTL ? held.stars : null;
  } catch {
    return null;
  }
}

// The API wants "owner/repo"; repoUrl is the page that slug came from.
function slug(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function useStars(): number | null {
  const [stars, setStars] = useState(cached);
  useEffect(() => {
    const repo = slug(site.repoUrl);
    if (!repo || cached() !== null) return;
    let live = true;
    fetch(`https://api.github.com/repos/${repo}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { stargazers_count?: unknown }) => {
        const n = body.stargazers_count;
        if (!live || typeof n !== "number") return;
        setStars(n);
        try {
          localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), stars: n }));
        } catch {
          // A blocked or full store only means the next visit asks again.
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return stars;
}

// Four digits would push the topbar around on a phone; nobody reads the exact
// figure at that size anyway.
export function compact(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
