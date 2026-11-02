import { useEffect, useState, type MouseEvent } from "react";
import { exerciseById } from "./data.ts";

export interface Route {
  id?: string;
  tab: "problem" | "solution";
}

export function parseRoute(pathname: string): Route {
  const [, id, tab] = pathname.split("/");
  if (!id || !exerciseById.has(id)) return { tab: "problem" };
  return { id, tab: tab === "solution" ? "solution" : "problem" };
}

export function routePath(r: Route): string {
  if (!r.id) return "/";
  return r.tab === "solution" ? `/${r.id}/solution` : `/${r.id}`;
}

const listeners = new Set<() => void>();

export function navigate(path: string): void {
  if (path === location.pathname + location.hash) return;
  history.pushState(null, "", path);
  for (const fn of listeners) fn();
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname));
    listeners.add(update);
    addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      removeEventListener("popstate", update);
    };
  }, []);
  return route;
}

// onLinkClick turns a plain left click on an in-app link into a client-side
// navigation, and leaves modified clicks (new tab, etc.) to the browser.
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute("href")!);
}
