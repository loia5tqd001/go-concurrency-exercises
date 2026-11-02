// Smoke test for the in-browser runner, run under Node: every exercise goes
// through the same compile -> link -> run pipeline the site uses.
//
//   node scripts/smoke-test.ts                     scaffolds must build, and their tests must fail
//   node scripts/smoke-test.ts --solutions ..      use <dir>/<id>/main.go; tests must pass
//   node scripts/smoke-test.ts --only 01,38        limit to exercises whose id starts with these
//   VERBOSE=1 node scripts/smoke-test.ts ...       also print each test binary's output
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Toolchain, runBinary, type SourceFile } from "../src/runner/toolchain.ts";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const solutions = arg("--solutions") && resolve(arg("--solutions")!);
const only = arg("--only")?.split(",");

const readJSON = (p: string) => JSON.parse(readFileSync(join(web, p), "utf8"));
const manifest = readJSON("src/generated/go-manifest.json");
const index = readJSON("src/generated/exercises.json");
const asset = (name: string) => new Uint8Array(gunzipSync(readFileSync(join(web, "public", manifest.assets[name].url))));

let t = performance.now();
const toolchain = new Toolchain(
  {
    compile: await WebAssembly.compile(asset("compile")),
    link: await WebAssembly.compile(asset("link")),
    gofmt: await WebAssembly.compile(asset("gofmt")),
  },
  asset("stdlib"),
);
console.log(`toolchain loaded in ${ms(t)}`);

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n${detail}`}`);
  if (!ok) failures++;
};

// Runner behavior that no exercise covers on its own.
{
  const dir = "/tmp/probe";
  const run = async (src: string, mode: "run" | "check" = "run") => {
    const files = [{ name: "main.go", content: src }];
    const res = await toolchain.build({ mode, importPath: "probe", dir, lang: index.lang, files });
    if (!res.ok || !res.binary) return { built: res.ok, code: -1, out: res.output };
    let out = "";
    const code = await runBinary(res.binary, { argv: ["probe"], dir, files, onOutput: (_, b) => (out += new TextDecoder().decode(b)) });
    return { built: true, code, out };
  };

  let r = await run(`package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello, wasm") }\n`);
  check(r.code === 0 && r.out === "hello, wasm\n", "go run prints and exits 0", r.out);

  r = await run(`package main\n\nfunc main() {\n\tc := make(chan int)\n\t<-c\n}\n`);
  check(r.code === 2 && r.out.includes("all goroutines are asleep - deadlock!"), "a deadlocked main is reported like native Go", r.out);

  r = await run(`package main\n\nfunc main() {\n\tx := 1\n}\n`, "check");
  check(!r.built && r.out.includes("./main.go:4:2: declared and not used: x"), "compile errors use ./main.go:line:col", r.out);

  const f = await toolchain.format("package main\nfunc  main( ) {\nx:=1\n_ = x}\n");
  check(f.output === "package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n", "gofmt formats", JSON.stringify(f));
}

for (const ex of index.exercises) {
  if (only && !only.some((p) => ex.id.startsWith(p))) continue;
  const data = readJSON(join("public", ex.data));
  const files: SourceFile[] = data.files.map((f: SourceFile) => ({ name: f.name, content: f.content }));
  let label = "scaffold";
  if (solutions) {
    const mine = join(solutions, ex.id, "main.go");
    if (!existsSync(mine)) continue;
    const content = readFileSync(mine, "utf8");
    if (content === files[0].content) continue; // not solved yet
    files[0] = { name: "main.go", content };
    label = "solution";
  }

  const dir = `/go-concurrency-exercises/${ex.id}`;
  t = performance.now();
  const res = await toolchain.build({ mode: "test", importPath: ex.importPath, dir, lang: index.lang, files, testMain: data.testMain });
  const buildTime = ms(t);
  if (!res.ok || !res.binary) {
    check(false, `${ex.id}: ${label} does not build`, res.output);
    continue;
  }

  let out = "";
  t = performance.now();
  const code = await runBinary(res.binary, {
    argv: [`${ex.id}.test`, "-test.timeout=10m0s", "-test.v"],
    dir,
    files,
    onOutput: (_, b) => (out += new TextDecoder().decode(b)),
  });
  const summary = `build ${buildTime}, run ${ms(t)}, exit ${code}`;
  if (process.env.VERBOSE) console.log(out);

  if (ex.unsupported) {
    console.log(`skip ${ex.id}: ${summary} (unsupported in browsers: ${ex.unsupported})`);
  } else if (solutions) {
    check(code === 0, `${ex.id}: solution passes (${summary})`, tail(out));
  } else {
    // A scaffold must fail on a real assertion, not crash the runner.
    const failedOnAssert = code === 1 && /--- FAIL: Test/.test(out);
    check(failedOnAssert, `${ex.id}: scaffold fails its tests (${summary})`, tail(out));
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

function tail(s: string) {
  return s.split("\n").slice(-15).join("\n");
}
