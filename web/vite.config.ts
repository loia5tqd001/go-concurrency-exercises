import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Monaco alone is a few MB; the warning is noise for this app.
    chunkSizeWarningLimit: 6000,
  },
});
