// The compile -> link pipeline `go test` and `go run` perform, driven by
// cmd/compile and cmd/link built for GOOS=js.
import { MemFS } from "./memfs.ts";
import { runGo, startGo } from "./go.ts";

export type BuildMode = "test" | "run" | "check";

export interface SourceFile {
  name: string;
  content: string;
}

export interface BuildRequest {
  mode: BuildMode;
  importPath: string;
  // dir is where the package's files live, also used as the working
  // directory when the binary runs, mirroring `go test`.
  dir: string;
  lang: string;
  files: SourceFile[];
  testMain?: string;
}

export interface BuildResult {
  ok: boolean;
  // output is what `go build` would print: empty on success, otherwise the
  // "# package" header followed by compiler or linker errors.
  output: string;
  binary?: Uint8Array;
}

export interface ToolchainModules {
  compile: WebAssembly.Module;
  link: WebAssembly.Module;
  // gofmt may still be downloading; format waits for it.
  gofmt?: WebAssembly.Module | Promise<WebAssembly.Module>;
}

const pkgDir = "/go/pkg";
const importcfg = "/go/importcfg";
const buildDir = "/tmp/build";
const eventsFile = `${buildDir}/_wasm_events.go`;
const eventsSrc = `package main\n\nimport _ "syscall/js"\n`;

export class Toolchain {
  private fs = new MemFS();
  private modules: ToolchainModules;
  private formatter?: (src: string) => { output?: string; error?: string };
  // Builds share one filesystem and one build directory, so they run one
  // at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(modules: ToolchainModules, stdlibBundle: Uint8Array) {
    this.modules = modules;
    this.loadStdlib(stdlibBundle);
  }

  build(req: BuildRequest): Promise<BuildResult> {
    const next = this.queue.then(() => this.build_(req));
    this.queue = next.catch(() => {});
    return next;
  }

  async format(src: string): Promise<{ output?: string; error?: string }> {
    if (!this.formatter) {
      const gofmt = await this.modules.gofmt;
      if (!gofmt) return { error: "formatter not loaded" };
      // The gofmt program registers goFormat and then blocks forever, so
      // starting it once is enough.
      await startGo(gofmt, { fs: new MemFS(), argv: ["gofmt"] });
      const g = globalThis as { goFormat?: (src: string) => { output?: string; error?: string } };
      this.formatter = g.goFormat;
      if (!this.formatter) return { error: "formatter failed to start" };
    }
    return this.formatter(src);
  }

  private loadStdlib(bundle: Uint8Array): void {
    const magic = new TextDecoder().decode(bundle.subarray(0, 8));
    if (magic !== "GOPKGS1\n") throw new Error("stdlib bundle: bad magic");
    const headerLen = new DataView(bundle.buffer, bundle.byteOffset + 8, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bundle.subarray(12, 12 + headerLen))) as {
      path: string;
      size: number;
    }[];
    let offset = 12 + headerLen;
    const lines: string[] = [];
    for (const { path, size } of header) {
      const file = `${pkgDir}/${path}.a`;
      this.fs.writeFile(file, bundle.subarray(offset, offset + size));
      lines.push(`packagefile ${path}=${file}`);
      offset += size;
    }
    this.fs.writeFile(importcfg, lines.join("\n") + "\n");
  }

  private async build_(req: BuildRequest): Promise<BuildResult> {
    const fs = this.fs;
    fs.removeAll(req.dir);
    fs.removeAll(buildDir);
    fs.mkdirAll(req.dir);
    fs.mkdirAll(buildDir);
    for (const f of req.files) fs.writeFile(`${req.dir}/${f.name}`, f.content);

    const isTest = req.mode !== "run";
    const goFiles = req.files
      .map((f) => f.name)
      .filter((n) => n.endsWith(".go") && (isTest || !n.endsWith("_test.go")))
      .map((n) => `./${n}`);
    if (req.mode === "run") {
      // A deadlock is reported through syscall/js's event handler (see
      // detectDeadlock), which a program that never imports os would not
      // link. Test binaries always link it through testing.
      fs.writeFile(eventsFile, eventsSrc);
      goFiles.push(eventsFile);
    }

    // `go test` compiles the package under its import path, not as main,
    // so the generated test main can import it.
    const pkgPath = req.mode === "run" ? "main" : req.importPath;
    const header =
      req.mode === "test" ? `# ${req.importPath} [${req.importPath}.test]\n` : `# ${req.importPath}\n`;

    let out = "";
    const decoder = new TextDecoder();
    const collect = (_fd: 1 | 2, bytes: Uint8Array) => {
      out += decoder.decode(bytes, { stream: true });
    };
    const tool = async (module: WebAssembly.Module, argv: string[]) => {
      out = "";
      const code = await runGo(module, { fs, argv, cwd: req.dir, onOutput: collect });
      return code === 0;
    };
    const compileFlags = [`-lang=${req.lang}`, "-complete", "-dwarf=false", "-nolocalimports", "-pack"];

    const pkgArchive = `${buildDir}/_pkg_.a`;
    if (!(await tool(this.modules.compile, ["compile", "-o", pkgArchive, "-p", pkgPath, ...compileFlags, "-importcfg", importcfg, ...goFiles]))) {
      return { ok: false, output: header + out };
    }
    if (req.mode === "check") return { ok: true, output: "" };

    let mainArchive = pkgArchive;
    let linkcfg = importcfg;
    if (req.mode === "test") {
      if (!req.testMain) return { ok: false, output: `no test files in ${req.importPath}\n` };
      linkcfg = `${buildDir}/importcfg`;
      fs.writeFile(linkcfg, decoder.decode(fs.readFile(importcfg)) + `packagefile ${req.importPath}=${pkgArchive}\n`);
      fs.writeFile(`${buildDir}/_testmain.go`, req.testMain);
      mainArchive = `${buildDir}/_testmain.a`;
      if (!(await tool(this.modules.compile, ["compile", "-o", mainArchive, "-p", "main", ...compileFlags, "-importcfg", linkcfg, `${buildDir}/_testmain.go`]))) {
        return { ok: false, output: header + out };
      }
    }

    const binary = `${buildDir}/a.out`;
    const linkFlags = ["-s", "-w", "-buildmode=exe", ...(req.mode === "test" ? ["-X", "testing.testBinary=1"] : [])];
    if (!(await tool(this.modules.link, ["link", "-o", binary, "-importcfg", linkcfg, ...linkFlags, mainArchive]))) {
      return { ok: false, output: header + out };
    }
    // Copy out of the filesystem so the next build cannot clobber it.
    return { ok: true, output: "", binary: fs.readFile(binary).slice() };
  }
}

export interface RunBinaryOptions {
  argv: string[];
  dir: string;
  files: SourceFile[];
  onOutput: (fd: 1 | 2, bytes: Uint8Array) => void;
}

// runBinary runs a linked program in a fresh filesystem that holds only its
// package's sources (some tests parse main.go) and an empty /tmp.
export async function runBinary(binary: Uint8Array, opts: RunBinaryOptions): Promise<number> {
  const fs = new MemFS();
  fs.mkdirAll("/tmp");
  fs.mkdirAll("/home/gopher");
  fs.mkdirAll(opts.dir);
  for (const f of opts.files) fs.writeFile(`${opts.dir}/${f.name}`, f.content);
  const module = await WebAssembly.compile(binary as BufferSource);
  return runGo(module, { fs, argv: opts.argv, cwd: opts.dir, onOutput: opts.onOutput, detectDeadlock: true });
}
