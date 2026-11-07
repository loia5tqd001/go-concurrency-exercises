// The README diagram is the door to a Problem scene. The ASCII fence stays
// the default view; a chip replaces it in place with the stage, and the
// appended Diagram chip swaps the fence back (artist review section 4.1).
//
// Goal scenes mount on the pinned fence too. Decision 36 turns this on in the
// same change as the door: the vocabulary and spoiler checks already pass in
// check-visuals, so a goal word can no longer leak a solution identifier.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SceneDef, VizSpec } from "./engine/model.ts";
import { onDoorIntent } from "./doorIntent.ts";
import { Icon } from "./view/icons.tsx";
import { Player } from "./view/Player.tsx";

export const GOAL_IN_PROBLEM = true;

// One fence's door, attached to the fence element the hash matched. The fence
// is hidden, never removed, so the clone and the page keep the same default.
export function VizDoor({ spec, scenes, pre }: { spec: VizSpec; scenes: SceneDef[]; pre: HTMLElement }) {
  const [open, setOpen] = useState<string | null>(null);
  // A console link always opens step 1. A new session remounts the player
  // when the asked scene is already open, so a second click restarts it.
  const [session, setSession] = useState(0);
  const focusOnOpen = useRef(false);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    pre.classList.add("is-door");
    pre.classList.toggle("is-door-hidden", open !== null);
    return () => pre.classList.remove("is-door", "is-door-hidden");
  }, [pre, open]);

  const scene = scenes.find((candidate) => candidate.id === open);
  // One scene per door keeps the player to a single script. The key remounts
  // it, so a chip always starts on step 1.
  const shown = useMemo(() => (scene === undefined ? [] : [scene]), [scene]);

  // Diagram is one of the views and always sits first, so the chip row never
  // changes between views. The scene chips carry the play glyph in both
  // views; the Diagram chip has none (decision 56). Exactly one radio is
  // checked, and Diagram is checked in Diagram view (decision 52).
  const items = useMemo(
    () => [{ id: "", label: "Diagram" }, ...scenes.map((candidate) => ({ id: candidate.id, label: candidate.chip }))],
    [scenes],
  );

  // The console (in CodePane) is a sibling of this door. A link announces one
  // intent; this door answers only when it draws that exercise and scene.
  useEffect(
    () =>
      onDoorIntent(spec.exercise, (intent) => {
        if (!scenes.some((candidate) => candidate.id === intent.scene)) return;
        focusOnOpen.current = true;
        setOpen(intent.scene);
        setSession((value) => value + 1);
      }),
    [spec.exercise, scenes],
  );

  // Focus follows the link into the figure, so a keyboard user can Tab on
  // from the chip row. Chip clicks keep their own focus.
  useLayoutEffect(() => {
    if (!focusOnOpen.current || open === null) return;
    focusOnOpen.current = false;
    const position = items.findIndex((item) => item.id === open);
    chipRefs.current[position]?.focus();
  }, [open, session, items]);

  const showDiagram = (): void => {
    // Diagram stays mounted, so focus it rather than a scene chip that would
    // unmount. The checked radio and the focus then agree.
    chipRefs.current[0]?.focus();
    setOpen(null);
  };

  const onChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, position: number): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Alt+← is the browser's Back.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    // Arrows do not wrap: at either end of the row an arrow is a no-op, so
    // one press cannot close the stage by accident (decision 47).
    const next = position + delta;
    const item = items[next];
    if (item === undefined) return;
    if (item.id === "") {
      showDiagram();
      return;
    }
    setOpen(item.id);
    chipRefs.current[next]?.focus();
  };

  return (
    <div className="viz-door">
      {/* The bar is first in the DOM and first on screen, so the chip row is
          the top of the door in both views (decision 51). */}
      <div className="viz-door-bar">
        {/* Each scene chip carries the play glyph in both views, so the row
            keeps the same width and no chip moves (decision 56). The Diagram
            chip has no glyph. The bar holds only chips; the step counter is
            in the player's footer (decision 65). */}
        <div className="viz-chips-group" role="radiogroup" aria-label="Scene">
          {items.map((item, position) => {
            const on = item.id === (open ?? "");
            const tab = on;
            return (
              <button
                key={item.id === "" ? "diagram" : item.id}
                ref={(element) => {
                  chipRefs.current[position] = element;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={tab ? 0 : -1}
                className={on ? "viz-chip is-on" : "viz-chip"}
                onClick={() => {
                  if (item.id === "") showDiagram();
                  else setOpen(item.id);
                }}
                onKeyDown={(event) => onChipKeyDown(event, position)}
              >
                {item.id !== "" && <Icon name="play" />}
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      {scene !== undefined && (
        <Player key={`${scene.id}:${session}`} spec={spec} scenes={shown} hideChips autoplay />
      )}
    </div>
  );
}

// The revealed solution shows how the fix works: the inside scenes sit at the
// top of the write-up, behind the existing reveal. Goal and inside scenes are
// not repeated here once they have a door (decision 36).
export function VizSolution({ spec }: { spec: VizSpec | null }) {
  const scenes = useMemo(
    () => spec?.scenes.filter((scene) => scene.tier === "inside") ?? [],
    [spec],
  );
  if (spec === null || scenes.length === 0) return null;
  return (
    <div className="viz-solution">
      <Player spec={spec} scenes={scenes} />
    </div>
  );
}
