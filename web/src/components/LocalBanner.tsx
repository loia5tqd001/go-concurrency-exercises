import { InfoIcon } from "./icons.tsx";

// The loading skeleton and the loaded code pane render the same banner. It
// depends only on the exercise summary, so it can be correct before the
// exercise data or visualisation spec arrives.
export function LocalBanner({ unsupported }: { unsupported?: string }) {
  if (!unsupported) return null;
  return (
    <div className="banner local-banner" role="status">
      <InfoIcon />
      <span>
        <strong>Run the tests on your computer.</strong> The browser can build this exercise, but not run its tests. {unsupported}.
      </span>
    </div>
  );
}
