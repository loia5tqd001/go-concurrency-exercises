import { useEffect, useState } from "react";
import { loadHome, site } from "../data.ts";
import { recommendedExercises } from "../recommended.ts";
import { onLinkClick } from "../router.ts";
import { PlayIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

export function Home() {
  const [readme, setReadme] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadHome().then(
      (h) => setReadme(h.readme),
      (err) => setError(String(err)),
    );
  }, []);
  const first = recommendedExercises(site.exercises)[0] ?? site.exercises[0];
  const basics = site.exercises.find((exercise) => exercise.id === "00-limit-crawler") ?? site.exercises[0];
  const starterName = first.title.split(":")[0] ?? first.title;

  return (
    <div className="home">
      <div className="home-inner">
        <section className="hero">
          <h1>Practice Go concurrency in your browser</h1>
          <p className="lede">
            {site.exercises.length} exercises on goroutines, channels, <code>select</code>, <code>sync</code> and <code>context</code>.
            Each one gives you a buggy <code>main.go</code> and a test suite. Fix <code>main.go</code> until <code>go test</code> passes.
          </p>
          <p>
            The real Go {site.goVersion} compiler and linker run in this tab as WebAssembly. You do not need to install or clone
            anything, and no server runs your code. Your work stays in this browser.
          </p>
          <div className="hero-actions">
            <a className="btn primary large" href={`/${first.id}`} onClick={onLinkClick}>
              <PlayIcon /> Start with {starterName}
            </a>
            <a className="btn large" href={`/${basics.id}`} onClick={onLinkClick}>
              Start from the basics
            </a>
          </div>
          <p className="muted small">
            One difference from your machine: browsers cannot run the race detector, so run <code>go test -race</code> locally before
            you call a solution done.
          </p>
        </section>
        {error ? <p className="muted">Could not load the overview: {error}</p> : readme ? <Markdown src={readme} ctx={{ dir: "/" }} /> : null}
      </div>
    </div>
  );
}
