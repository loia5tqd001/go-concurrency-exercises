import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { goClient } from "./runner/client.ts";
import "./styles.css";

// Start the toolchain download at once: it is the slowest thing on the page,
// and the learner reads the problem in the meantime.
goClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
