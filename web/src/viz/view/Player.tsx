// The player: transport, scrubber, knobs, the graph, and the words under it.
//
// The scene runs once, up front, in the scheduler. Playback only moves a
// position along that run's timeline, so Step back, the scrubber, and a
// replay all show the same schedule.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { MicroStep, Params, SceneDef, Value, VizSpec } from "../engine/model.ts";
import { defaultParams, parseCode, resolveModel, runModel, runScene, valueText } from "../engine/sim.ts";
import { layout } from "../engine/layout.ts";
import {
  buildTimeline,
  frameAt,
  nextStop,
  positionOf,
  positionOfStep,
  prevStop,
  slowFor,
  stepAt,
  type Timeline,
} from "../engine/timeline.ts";
import { useReducedMotion } from "../useReducedMotion.ts";
import { CodePanel } from "./CodePanel.tsx";
import { Graph } from "./Graph.tsx";
import { Icon } from "./icons.tsx";

interface Props {
  spec: VizSpec;
  scenes: readonly SceneDef[];
  // The door draws its own chips; the Solution block lets the player draw them.
  hideChips?: boolean;
  autoplay?: boolean;
}

const SPEEDS = [0.5, 1, 2] as const;

export function Player({ spec, scenes, hideChips = false, autoplay = false }: Props) {
  const reduce = useReducedMotion();
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = scenes[Math.min(sceneIndex, scenes.length - 1)]!;
  const [knobs, setKnobs] = useState<Record<string, Params>>({});
  // One object per knob setting: a new P would rerun the scene every render.
  const P = useMemo(() => knobs[scene.id] ?? defaultParams(scene), [knobs, scene]);

  const model = useMemo(() => resolveModel(scene, P), [scene, P]);
  const run = useMemo(() => runModel(model, { P, seed: 1 }), [model, P]);
  const slow = useMemo(() => model.clock?.slow ?? specSlow(spec, scene), [spec, scene, model]);
  const timeline = useMemo(() => buildTimeline(run, slow), [run, slow]);
  const lines = useMemo(() => parseCode(model.code), [model]);
  const orderMayVary = useMemo(() => scheduleVaries(model, P), [model, P]);

  const [width, setWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry?.contentRect.width ?? 0);
      setWidth((old) => (Math.abs(old - w) >= 2 ? w : old));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const lay = useMemo(() => (width > 0 ? layout(model, run.edges, width) : undefined), [model, run.edges, width]);

  // ---- playback -----------------------------------------------------------

  const [p, setP] = useState(0);
  const [playing, setPlaying] = useState(autoplay && !reduce);
  const [speed, setSpeed] = useState<number>(1);
  const pRef = useRef(0);
  pRef.current = p;
  const [said, setSaid] = useState("");
  const [logOpen, setLogOpen] = useState(false);

  // A new run starts from the beginning.
  useEffect(() => {
    setP(0);
  }, [timeline]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    // The first frame sets the start. A frame's timestamp can be earlier than
    // performance.now() was when this effect ran, so a start taken here could
    // give a negative first step that slips back across the stop playback
    // just left, and pauses on it again.
    let last: number | undefined;
    let held = 0;
    const tick = (now: number): void => {
      const dt = last === undefined ? 0 : Math.max(0, Math.min(64, now - last));
      last = now;
      const before = pRef.current;
      let next: number;
      if (reduce) {
        // No flight: jump from one batch to the next.
        held += dt * speed;
        if (held < 900) {
          frame = requestAnimationFrame(tick);
          return;
        }
        held = 0;
        next = nextStop(timeline, before);
      } else {
        next = before + dt * speed;
      }
      const stop = crossedStop(timeline, before, next);
      if (stop !== undefined) {
        setP(stop);
        setPlaying(false);
        return;
      }
      if (next >= timeline.total) {
        setP(timeline.total);
        setPlaying(false);
        return;
      }
      setP(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, timeline, reduce]);

  const frame = frameAt(timeline, p);
  const atEnd = p >= timeline.total - 0.5;
  const step = stepAt(timeline, p);
  const event = step === undefined ? undefined : run.steps[step]?.event;
  // Playback moves in batches, so every row of the batch that just played is
  // "now"; the last of them is the step the player names.
  const current = useMemo(
    () =>
      new Set(
        step === undefined ? [] : (timeline.beats.find((b) => b.kind === "batch" && b.steps.includes(step))?.steps ?? []),
      ),
    [step, timeline],
  );
  const caption = captionAt(timeline, p, model.stops?.map((stop) => stop.say) ?? []);

  // Playback is silent for screen readers; pausing or ending says where it
  // stopped, so a listener who pressed Play hears the caption or the verdict.
  useEffect(() => {
    if (playing || pRef.current <= 0) return;
    const end = pRef.current >= timeline.total - 0.5;
    setSaid(end ? okVerdict : (caption ?? event?.text ?? ""));
    // Only a change of `playing` speaks; the other values are read as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const play = (): void => {
    if (atEnd) setP(0);
    setPlaying(true);
  };
  const goTo = useCallback(
    (target: number, announce: boolean): void => {
      setPlaying(false);
      setP(Math.max(0, Math.min(timeline.total, target)));
      if (announce) {
        const s = stepAt(timeline, target);
        const text = s === undefined ? "Start." : run.steps[s]?.event.text ?? "";
        setSaid(target >= timeline.total - 0.5 && run.verdict !== "" ? `${text} ${run.verdict}` : text);
      }
    },
    [run, timeline],
  );
  const selectStep = useCallback(
    (index: number): void => goTo(positionOfStep(timeline, index), true),
    [goTo, timeline],
  );
  const stepForward = (): void => goTo(nextStop(timeline, p), true);
  const stepBack = (): void => goTo(prevStop(timeline, p), true);
  const restart = (): void => {
    setP(0);
    setPlaying(!reduce);
  };

  // ---- focus: a node on the graph and its lines in the code -------------

  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const focus = hover ?? pinned;
  const onFocus = useCallback((id: string | null, pin: boolean) => {
    if (pin) setPinned((old) => (old === id ? null : id));
    else setHover(id);
  }, []);

  // ---- expand -----------------------------------------------------------

  const [expanded, setExpanded] = useState(false);
  const figRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // The figure leaves the page's flow while large; a spacer of its old height
  // keeps the document from collapsing and jumping when it closes.
  const [hold, setHold] = useState(0);
  const toggleExpanded = (): void => {
    if (!expanded) setHold(figRef.current?.getBoundingClientRect().height ?? 0);
    setExpanded((v) => !v);
  };
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sim-lock");
    // The large view is modal: focus moves in, and returns to the button on close.
    const opener = expandRef.current;
    opener?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sim-lock");
      opener?.focus();
    };
  }, [expanded]);

  // Tab stays inside the large view.
  const trapTab = (event: KeyboardEvent<HTMLElement>): void => {
    if (!expanded || event.key !== "Tab") return;
    const box = figRef.current;
    if (box === null) return;
    const items = [...box.querySelectorAll<HTMLElement>("button, summary, input, [tabindex='0']")].filter(
      (el) => el.tabIndex >= 0 && el.offsetParent !== null,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const at = document.activeElement;
    if (event.shiftKey && at === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    trapTab(event);
    // Alt+←, Cmd+K and the like belong to the browser; a focusable code panel
    // scrolls with the arrows.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target as HTMLElement;
    if (target.closest(".sim-code-body") !== null) return;
    const inControl = target.closest("button, input, select, summary, [role='button']") !== null;
    if (event.key === "k" || event.key === "K" || (event.key === " " && !inControl)) {
      event.preventDefault();
      if (playing) setPlaying(false);
      else play();
      return;
    }
    // On the scrubber the arrows step too: its own step is a thousandth of
    // the run, and would skip every stop and announce nothing.
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepForward();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepBack();
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0, true);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(timeline.total, true);
    }
  };

  // ---- words under the graph ------------------------------------------

  const world = frame === undefined ? run.initial : frame.beat.kind === "batch" && frame.f >= 0.5 ? frame.beat.to : frame.beat.from;
  const t = frame?.t ?? 0;
  const budget = model.clock?.budget;
  const over = budget !== undefined && t > budget.at;
  const tests = Object.entries(model.tests ?? {});
  // A printed value stays at "stdout" for the rest of the run.
  const printed = world.printed.map((id) => run.world.tokens[id]);
  // A clean run can still fail a test (06 Today returns every goroutine, too
  // late). The end line says both, and reads as a failure.
  const failing = [...new Set(tests.filter(([id]) => run.world.tests[id] === "fail").map(([, test]) => test.short))];
  const finished = `The run finished${model.clock !== undefined ? ` in ${run.t} ms` : ""}.`;
  const limit = budget === undefined ? "" : ` The limit was ${budget.at} ms.`;
  const okVerdict =
    run.outcome !== "ok"
      ? run.verdict
      : failing.length > 0
        ? `${finished}${limit} ${failing.length} ${failing.length === 1 ? "test" : "tests"} failed: ${failing.join(", ")}.`
        : `${finished}${limit} ${tests.length > 0 ? "All tests passed." : "The run is complete."}`;
  // An exit can be the goal (04 ends with os.Exit(1)); it reads as a
  // failure only when a test fails.
  const bad = failing.length > 0 || (run.outcome !== "ok" && run.outcome !== "exit");
  const marks = [
    ...(budget !== undefined ? [{ at: positionOf(timeline, budget.at), label: `${budget.label} ${budget.at} ms`, kind: "budget" }] : []),
  ].filter((mark) => mark.at !== undefined);

  const label = `${scene.chip}: ${scene.summary}`;

  return (
    <>
    {/* The backdrop is the figure's sibling, not its child: the large figure
        is its own stacking layer, so a child backdrop would paint over the
        figure's background and dim the figure itself. */}
    {expanded && <div className="sim-backdrop" aria-hidden="true" onClick={() => setExpanded(false)} />}
    {expanded && <div className="sim-hold" aria-hidden="true" style={{ height: hold }} />}
    <figure
      ref={figRef}
      className={`sim${expanded ? " is-expanded" : ""}`}
      aria-label={label}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      onKeyDown={onKeyDown}
    >
      {!hideChips && scenes.length > 1 && (
        <div className="sim-chips" role="radiogroup" aria-label="Scene">
          {scenes.map((candidate, i) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={i === sceneIndex}
              tabIndex={i === sceneIndex ? 0 : -1}
              className={i === sceneIndex ? "sim-chip is-on" : "sim-chip"}
              onClick={() => {
                setSceneIndex(i);
                setPlaying(autoplay && !reduce);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                const next = i + (event.key === "ArrowLeft" ? -1 : 1);
                if (next < 0 || next >= scenes.length) return;
                setSceneIndex(next);
                setPlaying(autoplay && !reduce);
                (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
              }}
            >
              {candidate.chip}
            </button>
          ))}
        </div>
      )}

      <div className="sim-bar">
        <div className="sim-transport">
          <button type="button" className="sim-btn" onClick={restart} aria-label="Restart" title="Restart">
            <Icon name="restart" />
          </button>
          <button type="button" className="sim-btn" onClick={stepBack} aria-label="Step back" title="Step back (←)" aria-disabled={p <= 0}>
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="sim-btn sim-play"
            onClick={() => (playing ? setPlaying(false) : play())}
            title={playing ? "Pause (K)" : "Play (K)"}
          >
            <Icon name={playing ? "pause" : "play"} />
            <span>{playing ? "Pause" : atEnd ? "Replay" : p > 0 ? "Continue" : "Play"}</span>
          </button>
          <button type="button" className="sim-btn" onClick={stepForward} aria-label="Step" title="Step (→)" aria-disabled={atEnd}>
            <Icon name="step" />
          </button>
        </div>
        <div className="sim-seg" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="sim-tools">
          <button
            type="button"
            className="sim-btn"
            ref={expandRef}
            onClick={toggleExpanded}
            aria-label={expanded ? "Close the large view" : "Open a large view"}
            title={expanded ? "Close (Esc)" : "Large view"}
          >
            <Icon name={expanded ? "collapse" : "expand"} />
          </button>
        </div>
        {model.clock !== undefined && (
          <div className={`sim-clock${over ? " is-over" : ""}`} aria-hidden="true">
            <span className="sim-clock-t">t {Math.round(t)} ms</span>
            {budget !== undefined && <span className="sim-clock-budget">{`${over ? ">" : "≤"} ${budget.label} ${budget.at} ms`}</span>}
          </div>
        )}
      </div>

      <div className="sim-scrub">
        <input
          type="range"
          min={0}
          // Continuous: a range input snaps its thumb and fill to `step`, so any
          // coarse step makes playback jump. The arrows are handled by the
          // player (they step by batch), not by the input.
          max={Math.max(1, timeline.total)}
          step="any"
          value={p}
          aria-label="Position in the run"
          aria-valuetext={event?.text ?? "Start"}
          onChange={(e) => goTo(Number(e.currentTarget.value), false)}
          style={{ ["--sim-pos" as string]: `${timeline.total > 0 ? (p / timeline.total) * 100 : 0}%` }}
        />
        {marks.map((mark) => (
          <span
            key={mark.label}
            className={`sim-mark is-${mark.kind}`}
            style={{ left: `${((mark.at ?? 0) / Math.max(1, timeline.total)) * 100}%` }}
            title={mark.label}
            aria-hidden="true"
          />
        ))}
      </div>

      {(scene.knobs ?? []).length > 0 && (
        <div className="sim-knobs">
          {(scene.knobs ?? []).map((knob) => (
            <div className="sim-knob" key={knob.key}>
              <span>{knob.label}</span>
              <div className="sim-seg" role="group" aria-label={knob.label}>
                {knob.options.map((option) => (
                  <button
                    key={String(option)}
                    type="button"
                    aria-pressed={P[knob.key] === option}
                    onClick={() => {
                      setKnobs((old) => ({ ...old, [scene.id]: { ...P, [knob.key]: option as Value } }));
                      setPlaying(!reduce);
                    }}
                  >
                    {valueText(option)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sim-stage" ref={stageRef}>
        {lay !== undefined && (
          <Graph
            lay={lay}
            beat={frame?.beat}
            f={reduce && frame?.beat.kind === "batch" ? (frame.f > 0 ? 1 : 0) : (frame?.f ?? 0)}
            t={t}
            initial={run.initial}
            focus={focus}
            onFocus={onFocus}
            label={label}
          />
        )}
      </div>

      <div className="sim-below">
        {printed.length > 0 && (
          <div className="sim-stdout" aria-label="Output">
            <span className="sim-muted">stdout</span>
            {printed.map((tok, i) =>
              tok === undefined ? null : (
                <span key={i} className={`sim-chipval tone-${tok.tone % 3}`}>
                  {valueText(tok.v)}
                </span>
              ),
            )}
          </div>
        )}
        <p className={`sim-now${caption !== undefined ? " is-caption" : ""}`}>
          {atEnd ? <span className={bad ? "sim-verdict is-bad" : "sim-verdict is-ok"}>{okVerdict}</span> : (caption ?? event?.text ?? "Press Play to run it.")}
        </p>
        {tests.length > 0 && (
          <ul className="sim-tests" aria-label="Tests">
            {tests.map(([id, test]) => {
              const result = world.tests[id];
              return (
                <li key={id} className={result === undefined ? "is-pending" : `is-${result}`} title={test.name}>
                  <span className="sim-test-mark" aria-hidden="true">
                    {result === "pass" ? "✓" : result === "fail" ? "✕" : "○"}
                  </span>
                  {test.short}
                  <span className="sr-only">{result === undefined ? "no result yet" : result === "pass" ? "passes" : "fails"}</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="sim-insight">{inlineCode(model.insight)}</p>
        <div className="sim-meta">
          <Legend world={world} />
          {orderMayVary && <span className="sim-order-vary">order may vary</span>}
        </div>
      </div>

      {lines.length > 0 && <CodePanel model={model} lines={lines} world={world} focus={focus} onFocus={onFocus} />}

      {/* The list renders only while open: playback re-renders the player on
          every frame, and a closed list of a few hundred steps would cost
          that time for nothing. */}
      <details className="sim-log" onToggle={(event) => setLogOpen(event.currentTarget.open)}>
        <summary>
          Every step <span className="sim-muted">({run.steps.length})</span>
        </summary>
        {logOpen && (
          <StepLog steps={run.steps} current={current} showTime={model.clock !== undefined} onSelect={selectStep} />
        )}
      </details>

      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </figure>
    </>
  );
}

interface StepLogProps {
  steps: readonly MicroStep[];
  current: ReadonlySet<number>;
  showTime: boolean;
  onSelect: (index: number) => void;
}

// Playback changes `p` every animation frame. Keep the long transcript out of
// that render path, and move only its own scroll container when the current
// row needs to be followed.
const StepLog = memo(function StepLog({ steps, current, showTime, onSelect }: StepLogProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const currentStep = [...current].at(-1);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (list === null || list === undefined || row === null || row === undefined) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const pad = 8;
    if (rowBox.top < listBox.top + pad) {
      list.scrollTop += rowBox.top - listBox.top - pad;
    } else if (rowBox.bottom > listBox.bottom - pad) {
      list.scrollTop += rowBox.bottom - listBox.bottom + pad;
    }
  }, [current]);

  return (
    <ol ref={listRef}>
      {steps.map((s, i) => (
        <li key={i}>
          <button
            type="button"
            className={current.has(i) ? "is-now" : undefined}
            aria-current={currentStep === i ? "step" : undefined}
            onClick={() => onSelect(i)}
          >
            {showTime && <span className="sim-muted">{s.event.t} ms</span>}
            {s.event.text}
          </button>
        </li>
      ))}
    </ol>
  );
});

function Legend({ world }: { world: { g: Record<string, { status: string }> } }) {
  const states = new Set(Object.values(world.g).map((view) => view.status));
  const items: [string, string][] = [
    ["is-run", "running"],
    ["is-wait", "blocked"],
    ["is-done", "returned"],
  ];
  if (states.has("idle")) items.push(["is-idle", "not started"]);
  items.push(["is-bad", "stuck forever or crashed"]);
  return (
    <ul className="sim-legend" aria-label="Legend">
      {items.map(([cls, word]) => (
        <li key={word}>
          <i className={cls} aria-hidden="true" />
          {word}
        </li>
      ))}
    </ul>
  );
}

// `code` in insight text renders as code.
function inlineCode(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}

function crossedStop(timeline: Timeline, before: number, after: number): number | undefined {
  for (const beat of timeline.beats) {
    if (beat.stop === undefined) continue;
    const end = beat.start + beat.d;
    if (end > before + 0.5 && end <= after) return end;
  }
  return undefined;
}

// A stop's caption holds until the next batch has played, so it never
// describes a moment the graph has already left.
function captionAt(timeline: Timeline, p: number, says: readonly string[]): string | undefined {
  let caption: string | undefined;
  for (const beat of timeline.beats) {
    if (beat.kind !== "batch" || beat.start + beat.d > p + 0.5) continue;
    caption = beat.stop === undefined ? undefined : says[beat.stop];
  }
  return caption;
}

// Scenes that share a door share one pace, so their durations compare
// honestly: the slowest Problem scene sets it.
function specSlow(spec: VizSpec, scene: SceneDef): number {
  const problem = scene.tier === "today" || scene.tier === "goal";
  const group = problem ? spec.scenes.filter((s) => s.tier === "today" || s.tier === "goal") : [scene];
  let longest = 0;
  for (const s of group) {
    try {
      longest = Math.max(longest, runScene(s).t);
    } catch {
      // A broken scene shows its own error; it does not set the pace.
    }
  }
  return slowFor(longest);
}

// Does another seed give another event order? Then the scene can say so.
function scheduleVaries(model: ReturnType<typeof resolveModel>, P: Params): boolean {
  const sign = (seed: number): string =>
    runModel(model, { P, seed })
      .steps.map((s) => s.event.text)
      .join("|");
  const base = sign(1);
  for (let seed = 2; seed <= 4; seed++) if (sign(seed) !== base) return true;
  return false;
}
