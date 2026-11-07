import type { VizSpec } from "./engine/model.ts";

type SpecModule = { default: VizSpec };
type Loader = () => Promise<SpecModule>;

// One lazy chunk per spec file. The glob keeps the list in step with the
// folder, so a new spec needs no registry edit. The `[0-9]` prefix leaves
// _template.ts out. Never build a spec path from a variable, because Vite
// cannot see it and would not emit a chunk.
const modules = import.meta.glob<SpecModule>("./specs/[0-9]*.ts");

const loaders: Record<string, Loader> = {};
for (const [path, load] of Object.entries(modules)) {
  loaders[path.slice("./specs/".length, -".ts".length)] = load;
}

export const vizIds = Object.keys(loaders).sort();
export const hasViz = (id: string): boolean => Object.hasOwn(loaders, id);
export const loadViz = (id: string): Loader | undefined => loaders[id];
