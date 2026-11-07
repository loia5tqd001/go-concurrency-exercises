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
            {site.exercises.length} short Go exercises. Each one has a broken <code>main.go</code> and tests. Fix the code until the
            tests pass.
          </p>
          <p>
            The real Go {site.goVersion} compiler runs in this tab. Nothing is installed. No server runs your code.
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
            The browser cannot run Go's race detector. Before you finish, run <code>go test -race</code> on your computer.
          </p>
        </section>
        {error ? <p className="muted">The overview did not load: {error}</p> : readme ? <Markdown src={readme} ctx={{ dir: "/" }} /> : null}
      </div>
    </div>
  );
}
