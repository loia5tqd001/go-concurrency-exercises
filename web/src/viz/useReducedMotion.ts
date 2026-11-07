import { useEffect, useState } from "react";

// useReducedMotion starts paused in the player; the CSS block alone only
// removes transitions, so the player must also know the preference.
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduce;
}
