import { useCallback, useEffect, useState } from "react";
import { ExerciseView } from "./components/ExerciseView.tsx";
import { Home } from "./components/Home.tsx";
import { GitHubIcon, Logo, MenuIcon, MonitorIcon, MoonIcon, PanelIcon, SunIcon } from "./components/icons.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { exerciseById, site } from "./data.ts";
import { useToolchain, type ToolchainState } from "./runner/client.ts";
import { onLinkClick, useRoute } from "./router.ts";
import { compact, useStars } from "./stars.ts";
import { loadPref, loadStatus, savePref, saveStatus, type Status } from "./storage.ts";
import { useTheme } from "./theme.ts";

export function App() {
  const route = useRoute();
  const theme = useTheme();
  const toolchain = useToolchain();
  const stars = useStars();
  // navOpen drives the drawer below 901px; navCollapsed is the remembered
  // desktop preference. Each toggle button is hidden at the other width.
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => loadPref("nav-collapsed") === "1");
  const [statuses, setStatuses] = useState<Record<string, Status | null>>(() =>
    Object.fromEntries(site.exercises.map((e) => [e.id, loadStatus(e.id)])),
  );
  const summary = route.id ? exerciseById.get(route.id) : undefined;

  useEffect(() => {
    savePref("nav-collapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  useEffect(() => {
    document.title = summary ? `${summary.number}. ${summary.title} · Go Concurrency Exercises` : "Go Concurrency Exercises";
  }, [summary]);

  const setStatus = useCallback((id: string, status: Status | null) => {
    saveStatus(id, status);
    setStatuses((prev) => ({ ...prev, [id]: status }));
  }, []);

  const ThemeIcon = theme.pref === "light" ? SunIcon : theme.pref === "dark" ? MoonIcon : MonitorIcon;

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn nav-toggle" aria-label="Exercises" aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
          <MenuIcon />
        </button>
        <button
          className="icon-btn nav-collapse"
          aria-label={navCollapsed ? "Show exercise list" : "Hide exercise list"}
          aria-expanded={!navCollapsed}
          aria-controls="exercise-nav"
          title={navCollapsed ? "Show exercise list" : "Hide exercise list"}
          onClick={() => setNavCollapsed((c) => !c)}
        >
          <PanelIcon />
        </button>
        <a className="brand" href="/" onClick={onLinkClick}>
          <Logo /> <span>Concurrency Exercises</span>
        </a>
        <span className="spacer" />
        <ToolchainStatus state={toolchain} />
        <button className="icon-btn" onClick={theme.cycle} title={`Theme: ${theme.pref} (click to change)`} aria-label={`Theme: ${theme.pref}`}>
          <ThemeIcon />
        </button>
        <a
          className="repo-btn"
          href={site.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={stars === null ? "GitHub repository" : `GitHub repository, ${stars} stars`}
          title={stars === null ? "Star this project on GitHub" : `Star this project on GitHub — ${stars} so far`}
        >
          <GitHubIcon />
          {stars !== null && <span className="count">{compact(stars)}</span>}
        </a>
      </header>
      <div className={`body${navCollapsed ? " nav-collapsed" : ""}`}>
        <Sidebar current={route.id} statuses={statuses} open={navOpen} onClose={() => setNavOpen(false)} />
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
        <main className="main">
          {summary ? (
            <ExerciseView
              key={summary.id}
              summary={summary}
              tab={route.tab}
              status={statuses[summary.id]}
              onStatus={(s) => setStatus(summary.id, s)}
            />
          ) : (
            <Home />
          )}
        </main>
      </div>
    </div>
  );
}

function ToolchainStatus({ state }: { state: ToolchainState }) {
  if (state.phase === "ready") {
    return (
      <span className="tc-status ready" title={`The Go ${site.goVersion} toolchain is loaded`}>
        <span className="dot" /> Go {site.goVersion}
      </span>
    );
  }
  if (state.phase === "error") {
    return (
      <span className="tc-status error" title={state.message}>
        <span className="dot" /> Go failed to load
      </span>
    );
  }
  const pct = state.total ? Math.floor((state.loaded / state.total) * 100) : 0;
  const mb = (n: number) => (n / (1 << 20)).toFixed(1);
  return (
    <span className="tc-status loading" title={`Downloading the Go toolchain: ${mb(state.loaded)} of ${mb(state.total)} MB. Later visits load it from the cache.`}>
      <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Go toolchain download">
        <span style={{ width: `${pct}%` }} />
      </span>
      Go {pct}%
    </span>
  );
}
