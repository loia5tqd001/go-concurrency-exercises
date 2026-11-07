import { useEffect, useState } from "react";
import type { VizSpec } from "./engine/model.ts";
import { loadViz } from "./registry.ts";

// One lazy spec chunk per exercise. The Problem tab mounts its door on the
// README fence and the Solution tab shows the inside scenes, so both read the
// same loaded spec rather than fetching it twice.
export function useVizSpec(id: string): VizSpec | null {
  const [spec, setSpec] = useState<VizSpec | null>(null);

  useEffect(() => {
    setSpec(null);
    const load = loadViz(id);
    if (!load) return undefined;
    let live = true;
    load().then(
      (module) => {
        if (live) setSpec(module.default);
      },
      // A missing chunk is the same as no spec: no door, no inside scenes.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id]);

  return spec;
}
