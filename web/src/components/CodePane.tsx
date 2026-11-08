import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ConsoleModel } from "../console.ts";
import { modKey, packageDir, site, type Exercise, type ExerciseSummary } from "../data.ts";
import { monaco, monoFont } from "../monaco.ts";
import { goClient, runBinary, useToolchain, type RunHandle } from "../runner/client.ts";
import type { BuildMode, BuildRequest, SourceFile } from "../runner/toolchain.ts";
import { clearCode, hash, loadCode, saveCode, type Status } from "../storage.ts";
import { navigate, routePath } from "../router.ts";
import { openDoor, specTestNames, todaySceneId } from "../viz/doorIntent.ts";
import type { VizSpec } from "../viz/engine/model.ts";
import { hasViz } from "../viz/registry.ts";
import { CheckIcon, CrossIcon, FormatIcon, InfoIcon, LockIcon, PlayIcon, ResetIcon, StopIcon, TerminalIcon } from "./icons.tsx";
import { LocalBanner } from "./LocalBanner.tsx";
import { paneFraction, Splitter } from "./Splitter.tsx";

type Busy = null | "test" | "run" | "build";
type TestState = "running" | "pass" | "fail";
export type OpenFile = (name: string, line?: number, col?: number) => void;

interface Props {
  summary: ExerciseSummary;
  exercise: Exercise;
  status: Status | null;
  spec: VizSpec | null;
  onStatus: (status: Status | null) => void;
  // openFile is filled in by CodePane so the docs beside it can open files.
  openFile: RefObject<OpenFile>;
}

// One compiler diagnostic: "./main.go:12:5: undefined: x".
const diagnosticRe = /^(?:\.\/)?([\w.-]+\.go):(\d+):(\d+): (.*)$/;

export function CodePane({ summary, exercise, status, spec, onStatus, openFile }: Props) {
  const id = summary.id;
  const dir = packageDir(id);
  const files = exercise.files;
  const scaffold = files.find((f) => f.name === "main.go")!.content;
  const toolchain = useToolchain();
  const ready = toolchain.phase === "ready";

  const hostRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>()).current;
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>()).current;
  const runRef = useRef<RunHandle | null>(null);
  const busyRef = useRef<Busy>(null);
  const consoleModel = useMemo(() => new ConsoleModel(), []);
  const statusRef = useRef(status);
  const onStatusRef = useRef(onStatus);
  statusRef.current = status;
  onStatusRef.current = onStatus;

  // The console shows a door link only when the spec names the failing test
  // and draws a Today scene (decision 5). ExerciseView resolves the lazy spec
  // once for both panes, after which this component only reads it.
  const vizLink = useMemo(() => {
    if (spec === null) return null;
    const scene = todaySceneId(spec);
    return scene === undefined ? null : { names: specTestNames(spec), scene };
  }, [spec]);
  // The console hooks are installed once, so they read the latest link
  // through a ref instead of a stale closure.
  const vizLinkRef = useRef(vizLink);
  vizLinkRef.current = vizLink;

  const openToday = () => {
    const link = vizLinkRef.current;
    if (link === null) return;
    // The door lives in the Problem tab. Navigating there first also covers
    // the Solution tab, where no door is mounted; the intent then waits for
    // the next door (doorIntent.ts).
    navigate(routePath({ id, tab: "problem" }));
    openDoor({ exercise: id, scene: link.scene, step: 0 });
  };

  const [active, setActive] = useState("main.go");
  const [busy, setBusyState] = useState<Busy>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [errorFiles, setErrorFiles] = useState<Set<string>>(new Set());
  const [stale, setStale] = useState(() => {
    const saved = loadCode(id);
    return !!saved && saved.base !== hash(scaffold) && saved.code !== scaffold;
  });

  const setBusy = (b: Busy) => {
    busyRef.current = b;
    setBusyState(b);
  };

  const sources = (): SourceFile[] =>
    files.map((f) => ({ name: f.name, content: models.get(f.name)?.getValue() ?? f.content }));

  const request = (mode: BuildMode): BuildRequest => ({
    mode,
    importPath: summary.importPath,
    dir,
    lang: site.lang,
    files: sources(),
    testMain: exercise.testMain,
  });

  const applyDiagnostics = (output: string) => {
    const byFile = new Map<string, monaco.editor.IMarkerData[]>();
    let last: monaco.editor.IMarkerData | undefined;
    for (const line of output.split("\n")) {
      const m = diagnosticRe.exec(line);
      if (m && models.has(m[1])) {
        const model = models.get(m[1])!;
        const lineNumber = Math.min(Number(m[2]), model.getLineCount());
        const column = Number(m[3]);
        const word = model.getWordAtPosition({ lineNumber, column });
        last = {
          severity: monaco.MarkerSeverity.Error,
          message: m[4],
          startLineNumber: lineNumber,
          startColumn: column,
          endLineNumber: lineNumber,
          endColumn: word ? word.endColumn : column + 1,
          source: "go build",
        };
        byFile.set(m[1], [...(byFile.get(m[1]) ?? []), last]);
      } else if (last && line.startsWith("\t")) {
        // "have (...)" / "want (...)" continuation lines.
        last.message += "\n" + line.trim();
      } else {
        last = undefined;
      }
    }
    for (const [name, model] of models) monaco.editor.setModelMarkers(model, "go", byFile.get(name) ?? []);
    setErrorFiles(new Set(byFile.keys()));
  };

  // ---- live diagnostics: type-check the package shortly after each edit ----
  const check = useRef({ timer: undefined as ReturnType<typeof setTimeout> | undefined, inflight: false, again: false }).current;
  const runCheck = async () => {
    if (goClient().state.phase !== "ready") return;
    if (check.inflight) {
      check.again = true;
      return;
    }
    check.inflight = true;
    try {
      const res = await goClient().build(request("check"));
      if (!check.again) applyDiagnostics(res.ok ? "" : res.output);
    } catch {
      // A failed check only means no squiggles; runs report real errors.
    } finally {
      check.inflight = false;
      if (check.again) {
        check.again = false;
        runCheck();
      }
    }
  };

  // ---- actions ----
  const switchTo: OpenFile = (name, line, col) => {
    const editor = editorRef.current;
    const model = models.get(name);
    if (!editor || !model) return;
    const current = editor.getModel();
    if (current !== model) {
      const prev = [...models].find(([, m]) => m === current)?.[0];
      if (prev) viewStates.set(prev, editor.saveViewState());
      editor.setModel(model);
      const vs = viewStates.get(name);
      if (vs) editor.restoreViewState(vs);
      editor.updateOptions({ readOnly: !files.find((f) => f.name === name)?.editable });
      setActive(name);
    }
    if (line) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: col ?? 1 });
    }
    editor.focus();
  };
  openFile.current = switchTo;

  const runTests = async (only?: string) => {
    if (busyRef.current || goClient().state.phase !== "ready") return;
    if (summary.unsupported) return buildOnly();
    setBusy("test");
    consoleModel.clear();
    consoleModel.command(`go test -v${only ? ` -run '^${only}$'` : ""} ./${id}`);
    setTests((prev) => (only ? { ...prev, [only]: "running" } : {}));
    try {
      const req = request("test");
      const res = await goClient().build(req);
      applyDiagnostics(res.ok ? "" : res.output);
      if (!res.ok || !res.binary) {
        consoleModel.write(res.output, 2);
        consoleModel.note(`FAIL\t${summary.importPath} [build failed]`, "fail");
        setTests({});
        if (!only) onStatus("failed");
        return;
      }
      const argv = [`${id}.test`, "-test.paniconexit0", "-test.timeout=10m0s", "-test.v=true"];
      if (only) argv.push(`-test.run=^${only}$`);
      const started = performance.now();
      const handle = runBinary(res.binary, { argv, dir, files: req.files }, (text, fd) => consoleModel.write(text, fd));
      runRef.current = handle;
      const code = await handle.exited;
      runRef.current = null;
      const secs = ((performance.now() - started) / 1000).toFixed(3);
      if (code === "stopped") {
        consoleModel.note("stopped", "fail");
        setTests((prev) => Object.fromEntries(Object.entries(prev).filter(([, s]) => s !== "running")));
      } else if (code === 0) {
        consoleModel.note(`ok  \t${summary.importPath}\t${secs}s`, "pass");
        if (!only) {
          onStatus("passed");
          consoleModel.note(`The browser has no race detector. Before you call it solved, also run: go test -race ./${id}`, "dim");
        }
      } else {
        consoleModel.note(`FAIL\t${summary.importPath}\t${secs}s`, "fail");
        if (!only) onStatus("failed");
      }
    } catch (err) {
      consoleModel.note(String(err), "fail");
    } finally {
      setBusy(null);
    }
  };

  const runMain = async () => {
    if (busyRef.current || goClient().state.phase !== "ready") return;
    setBusy("run");
    consoleModel.clear();
    consoleModel.command(`go run ./${id}`);
    try {
      const req = request("run");
      const res = await goClient().build(req);
      applyDiagnostics(res.ok ? "" : res.output);
      if (!res.ok || !res.binary) {
        consoleModel.write(res.output, 2);
        return;
      }
      const handle = runBinary(res.binary, { argv: [id], dir, files: req.files }, (text, fd) => consoleModel.write(text, fd));
      runRef.current = handle;
      const code = await handle.exited;
      runRef.current = null;
      if (code === "stopped") consoleModel.note("stopped", "fail");
      else if (code !== 0) consoleModel.note(`exit status ${code}`, "fail");
    } catch (err) {
      consoleModel.note(String(err), "fail");
    } finally {
      setBusy(null);
    }
  };

  const buildOnly = async () => {
    if (busyRef.current) return;
    setBusy("build");
    consoleModel.clear();
    consoleModel.command(`go test -c -o /dev/null ./${id}`);
    try {
      const res = await goClient().build(request("check"));
      applyDiagnostics(res.ok ? "" : res.output);
      if (res.ok) {
        consoleModel.note("The package and its tests compile.", "pass");
        consoleModel.note(`Run the tests locally: go test -race ./${id}`, "dim");
      } else {
        consoleModel.write(res.output, 2);
      }
    } finally {
      setBusy(null);
    }
  };

  const stop = () => runRef.current?.stop();

  const format = async () => {
    const editor = editorRef.current;
    const model = models.get("main.go");
    if (!editor || !model || goClient().state.phase !== "ready") return;
    const src = model.getValue();
    try {
      const res = await goClient().format(src);
      // Skip if the code changed while gofmt ran, or if it does not parse.
      if (res.output !== undefined && res.output !== src && model.getValue() === src) {
        const selection = editor.getModel() === model ? editor.getSelection() : null;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: res.output }], () => null);
        model.pushStackElement();
        if (selection) editor.setSelection(selection);
      }
    } catch {
      // Formatting is a convenience; the code is saved either way.
    }
    saveCode(id, model.getValue(), scaffold);
  };

  const replaceMain = (text: string) => {
    const model = models.get("main.go")!;
    // An edit instead of setValue keeps the reset undoable.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
  };

  const reset = () => {
    if (!confirm("Reset main.go to the original exercise? Your code for this exercise will be lost (Undo still works until you leave the page).")) return;
    replaceMain(scaffold);
    clearCode(id);
    onStatus(null);
    setStale(false);
    setTests({});
    switchTo("main.go");
  };

  const keepMine = () => {
    saveCode(id, models.get("main.go")!.getValue(), scaffold);
    setStale(false);
  };

  // The editor and the keyboard shortcuts call actions through a ref, so they
  // always reach the latest render's closures.
  const actions = useRef({ runTests, runMain, format, stop });
  actions.current = { runTests, runMain, format, stop };

  // ---- editor lifecycle ----
  useEffect(() => {
    const saved = loadCode(id);
    for (const f of files) {
      const content = f.name === "main.go" && saved ? saved.code : f.content;
      models.set(f.name, monaco.editor.createModel(content, "go", monaco.Uri.file(`${dir}/${f.name}`)));
    }
    const editor = monaco.editor.create(hostRef.current!, {
      model: models.get("main.go"),
      automaticLayout: true,
      fontFamily: monoFont,
      fontSize: 13,
      lineHeight: 20,
      tabSize: 4,
      insertSpaces: false,
      detectIndentation: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: false },
      readOnlyMessage: { value: "Only **main.go** is yours to edit; the other files define the exercise." },
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => actions.current.runTests());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => actions.current.runMain());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => actions.current.format());

    const main = models.get("main.go")!;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const sub = main.onDidChangeContent(() => {
      if (statusRef.current !== null) {
        statusRef.current = null;
        onStatusRef.current(null);
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        saveCode(id, main.getValue(), scaffold);
      }, 300);
      clearTimeout(check.timer);
      check.timer = setTimeout(runCheck, 500);
    });

    // The same shortcuts when focus is outside the editor.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || hostRef.current?.contains(e.target as Node)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) actions.current.runMain();
        else actions.current.runTests();
      } else if (e.key === "s") {
        e.preventDefault();
        actions.current.format();
      }
    };
    addEventListener("keydown", onKey);

    return () => {
      removeEventListener("keydown", onKey);
      if (saveTimer !== undefined) saveCode(id, main.getValue(), scaffold);
      clearTimeout(check.timer);
      sub.dispose();
      runRef.current?.stop();
      editor.dispose();
      for (const m of models.values()) m.dispose();
      models.clear();
      editorRef.current = null;
    };
  }, []);

  // Type-check once the toolchain is ready, so saved code shows its errors.
  useEffect(() => {
    if (ready) runCheck();
  }, [ready]);

  // ---- console wiring ----
  useEffect(() => {
    consoleModel.files = new Set(files.map((f) => f.name));
    consoleModel.hooks = {
      onLocation: (file, line, col) => openFile.current(file, line, col),
      onLine: (text) => {
        const run = /^=== RUN\s+([^/\s]+)$/.exec(text);
        if (run) return setTests((prev) => ({ ...prev, [run[1]]: "running" }));
        const done = /^--- (PASS|FAIL): ([^/\s]+) /.exec(text);
        if (done) setTests((prev) => ({ ...prev, [done[2]]: done[1] === "PASS" ? "pass" : "fail" }));
      },
      // A failing test earns a link only when its full name is in a tests row
      // of the spec. The door is a sibling, so the click announces the intent
      // rather than reaching into the doc pane.
      seeWhy: (test) => {
        const link = vizLinkRef.current;
        if (link === null || !link.names.has(test)) return null;
        return openToday;
      },
    };
    consoleModel.clear();
  }, []);

  // The greeting waits for the lazy spec: 04's note only earns its "Watch it
  // instead ▸" link once the spec proves it has a Today scene. Writing only
  // into an empty console makes the effect safe to re-run.
  useEffect(() => {
    if (hasViz(id) && spec === null) return;
    if (!consoleModel.empty) return;
    if (summary.unsupported) {
      const action = vizLink === null ? undefined : { label: "Watch the animation", run: openToday };
      consoleModel.note(`The browser cannot run these tests. ${summary.unsupported}.`, "err", action);
      consoleModel.note(`Press ${modKey}+Enter to build the code. Then run go test -race ./${id} on your computer.`, "dim");
    } else {
      consoleModel.note(`Press ${modKey}+Enter to run the tests (go test -v), or ${modKey}+Shift+Enter to run main().`, "dim");
    }
  }, [spec]);

  const loadingLabel =
    toolchain.phase === "loading"
      ? `Loading Go… ${toolchain.total ? Math.floor((toolchain.loaded / toolchain.total) * 100) : 0}%`
      : toolchain.phase === "error"
        ? "Go failed to load"
        : null;
  const testNames = exercise.tests ?? [];

  return (
    <section className="code-pane" aria-label="Code">
      <div className="code-toolbar">
        <div className="file-tabs" role="tablist" aria-label="Files">
          {files.map((f) => (
            <button
              key={f.name}
              id={`file-tab-${f.name}`}
              role="tab"
              aria-selected={active === f.name}
              aria-controls="code-editor"
              tabIndex={active === f.name ? 0 : -1}
              className={`file-tab${active === f.name ? " active" : ""}`}
              title={f.editable ? "Your solution goes here" : "Part of the exercise (read-only)"}
              onClick={() => switchTo(f.name)}
              onKeyDown={(event) => {
                const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const currentIndex = files.findIndex((file) => file.name === f.name);
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? files.length - 1
                      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + files.length) % files.length;
                const nextName = files[nextIndex].name;
                switchTo(nextName);
                document.getElementById(`file-tab-${nextName}`)?.focus();
              }}
            >
              {f.name}
              {!f.editable && <LockIcon className="muted" />}
              {errorFiles.has(f.name) && <span className="err-dot" aria-label="has errors" />}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button
            className="btn ghost"
            onClick={format}
            disabled={!ready}
            aria-label="Format main.go"
            title={`Format main.go with gofmt (${modKey}+S)`}
          >
            <FormatIcon /> <span className="label">Format</span>
          </button>
          <button className="btn ghost" onClick={reset} aria-label="Reset main.go" title="Reset main.go to the original exercise">
            <ResetIcon /> <span className="label">Reset</span>
          </button>
        </div>
      </div>

      <LocalBanner unsupported={summary.unsupported} />

      {stale && (
        <div className="banner" role="status">
          This exercise changed since you saved your code.
          <button className="btn small" onClick={reset}>
            Use the new version
          </button>
          <button className="btn small ghost" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}

      <div className="split-y" ref={splitRef} style={{ "--editor-frac": `${paneFraction("editor-frac", 0.62) * 100}%` } as CSSProperties}>
        <div
          className="editor-host"
          id="code-editor"
          role="tabpanel"
          aria-labelledby={`file-tab-${active}`}
          ref={hostRef}
        />
        <Splitter axis="y" target={splitRef} cssVar="--editor-frac" prefKey="editor-frac" min={0.15} max={0.85} />
        <div className="console">
          <div className="console-toolbar">
            {busy && busy !== "build" ? (
              <button className="btn danger" onClick={stop}>
                <StopIcon /> Stop
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={() => runTests()}
                disabled={!ready || !!busy}
                aria-label={summary.unsupported ? "Build only, tests require local Go" : undefined}
                title={summary.unsupported ? "Compile main.go and the tests" : `go test -v (${modKey}+Enter)`}
              >
                <PlayIcon /> {loadingLabel ?? (summary.unsupported ? "Build only" : "Run tests")}
                {!loadingLabel && <kbd>{modKey}↵</kbd>}
              </button>
            )}
            <button
              className="btn"
              onClick={runMain}
              disabled={!ready || !!busy}
              aria-label="Run main"
              title={`go run (${modKey}+Shift+Enter)`}
            >
              <TerminalIcon /> <span className="label">Run main</span>
            </button>
            <span className="spacer" />
            <details className="runtime-info">
              <summary className="btn ghost" aria-label="Browser runtime">
                <InfoIcon /> <span className="label">Browser runtime</span>
              </summary>
              <div className="popover">
                <p>
                  <strong>Real Go {site.goVersion}.</strong> The Go compiler runs in this tab. Your code stays in this browser.
                </p>
                <p>
                  <strong>No race detector.</strong> The browser cannot run <code>-race</code>. Run{" "}
                  <code>go test -race ./{id}</code> on your computer.
                </p>
                <p>
                  <strong>One thread.</strong> <code>GOMAXPROCS</code> is 1. A goroutine runs until it blocks. A busy loop can stop the
                  other goroutines.
                </p>
                <p>
                  <strong>No processes or signals.</strong> <code>os/exec</code> and <code>os/signal</code> cannot work here.
                </p>
              </div>
            </details>
            <button className="btn ghost" onClick={() => consoleModel.clear()} title="Clear the output">
              Clear
            </button>
          </div>
          {testNames.length > 0 && !summary.unsupported && (
            <div className="test-strip" aria-label="Tests">
              {testNames.map((t) => (
                <button
                  key={t}
                  className={`chip ${tests[t] ?? "idle"}`}
                  onClick={() => runTests(t)}
                  disabled={!ready || !!busy}
                  title={`Run only ${t}`}
                >
                  {tests[t] === "pass" ? <CheckIcon width={12} height={12} /> : tests[t] === "fail" ? <CrossIcon width={12} height={12} /> : <span className="chip-dot" />}
                  {t.replace(/^Test/, "")}
                </button>
              ))}
            </div>
          )}
          <div className="console-output" ref={consoleModel.attach} role="log" onClick={(e) => consoleModel.handleClick(e.target)} />
        </div>
      </div>
    </section>
  );
}
