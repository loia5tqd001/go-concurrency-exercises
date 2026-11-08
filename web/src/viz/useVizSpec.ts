import { useEffect, useState } from "react";
import type { VizSpec } from "./engine/model.ts";
import { hasViz, loadViz } from "./registry.ts";

export interface VizSpecState {
  spec: VizSpec | null;
  loading: boolean;
}

// Resolved chunks stay here for the rest of the session. Returning one
// synchronously prevents a loading flash when the learner revisits a page.
const loaded = new Map<string, VizSpec>();

function initialState(id: string): VizSpecState {
  const spec = loaded.get(id);
  return spec === undefined ? { spec: null, loading: hasViz(id) } : { spec, loading: false };
}

// One lazy spec chunk per exercise. The exercise view starts this import in
// parallel with its JSON request and does not mount the workspace until the
// result is settled. A late spec therefore cannot insert the door under text
// that is already on screen.
export function useVizSpec(id: string): VizSpecState {
  const [state, setState] = useState<VizSpecState>(() => initialState(id));

  useEffect(() => {
    const cached = loaded.get(id);
    if (cached !== undefined) {
      setState({ spec: cached, loading: false });
      return undefined;
    }

    const load = loadViz(id);
    if (!load) {
      setState({ spec: null, loading: false });
      return undefined;
    }

    setState({ spec: null, loading: true });
    let live = true;
    load().then(
      (module) => {
        loaded.set(id, module.default);
        if (live) setState({ spec: module.default, loading: false });
      },
      // A missing chunk is the same as no spec: no door and no inside scenes.
      // Treat it as settled so the readable exercise is not held hostage.
      () => {
        if (live) setState({ spec: null, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  return state;
}
