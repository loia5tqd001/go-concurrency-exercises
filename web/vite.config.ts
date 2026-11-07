import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const web = dirname(fileURLToPath(import.meta.url));
const repo = resolve(web, "..");

// docsPlugin regenerates the exercise data when a README or a solution doc
// changes, so a doc edit appears on save. It is a dev-only convenience:
// `npm run build` regenerates once through scripts/prepare.sh.
function docsPlugin(): Plugin {
  return {
    name: "go-concurrency-docs",
    apply: "serve",
    configureServer(server) {
      const exerciseReadmes = readdirSync(repo, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{2}[a-z]?-/.test(entry.name))
        .map((entry) => resolve(repo, entry.name, "README.md"));
      server.watcher.add([resolve(repo, "README.md"), resolve(repo, "solutions"), ...exerciseReadmes]);

      const isDoc = (file: string): boolean => {
        const relative = file.slice(repo.length + 1).replaceAll("\\", "/");
        return /^(README\.md|[0-9]{2}[a-z]?-[^/]+\/README\.md|solutions\/[^/]+\.md)$/.test(relative);
      };

      const regenerate = (file: string): void => {
        if (!isDoc(file)) return;
        try {
          execFileSync("go", ["run", "./tools/gen"], { cwd: web, stdio: "inherit" });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          server.config.logger.error(`gen: ${String(error)}`);
        }
      };

      server.watcher.on("change", regenerate);
      server.watcher.on("add", regenerate);
    },
  };
}

export default defineConfig({
  plugins: [react(), docsPlugin()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Monaco alone is a few MB; the warning is noise for this app.
    chunkSizeWarningLimit: 6000,
  },
});
