// The toolchain worker: downloads the Go compiler, linker and stdlib once,
// then serves builds and formatting for the page.
import manifest from "../generated/go-manifest.json";
import { Toolchain, type BuildRequest } from "./toolchain.ts";

type AssetName = keyof typeof manifest.assets;

const post = (msg: unknown, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

async function fetchAsset(name: AssetName, onBytes: (n: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const url = manifest.assets[name].url;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  let bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  // A host may serve the file with Content-Encoding: gzip, in which case the
  // browser has already decoded it; only decompress if the gzip magic
  // number is still there.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

const toolchain = (async () => {
  const { compile, link, stdlib } = manifest.assets;
  const total = compile.bytes + link.bytes + stdlib.bytes;
  let loaded = 0;
  let lastPost = 0;
  const onBytes = (n: number) => {
    loaded += n;
    const now = performance.now();
    if (now - lastPost > 100) {
      lastPost = now;
      post({ type: "state", state: { phase: "loading", loaded: Math.min(loaded, total), total } });
    }
  };
  post({ type: "state", state: { phase: "loading", loaded: 0, total } });

  const [compileModule, linkModule, stdlibBundle] = await Promise.all([
    fetchAsset("compile", onBytes).then((b) => WebAssembly.compile(b)),
    fetchAsset("link", onBytes).then((b) => WebAssembly.compile(b)),
    fetchAsset("stdlib", onBytes),
  ]);
  // The formatter is only needed on save, so it does not hold up the rest.
  const gofmt = fetchAsset("gofmt", () => {}).then((b) => WebAssembly.compile(b));
  gofmt.catch(() => {});

  const tc = new Toolchain({ compile: compileModule, link: linkModule, gofmt }, stdlibBundle);
  post({ type: "state", state: { phase: "ready" } });
  return tc;
})();

toolchain.catch((err) => {
  post({ type: "state", state: { phase: "error", message: err instanceof Error ? err.message : String(err) } });
});

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data as { id: number; type: string };
  try {
    const tc = await toolchain;
    if (type === "build") {
      const result = await tc.build(e.data.req as BuildRequest);
      post({ id, result }, result.binary ? [result.binary.buffer] : []);
    } else if (type === "format") {
      post({ id, result: await tc.format(e.data.src as string) });
    }
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
