// Small inline icons for the player and the door. currentColor only.

const paths = {
  play: "M4 2.5v11l9.5-5.5z",
  pause: "M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z",
  restart: "M8 3a5 5 0 1 1-4.6 3H1.5L4.5 2l3 4H5.6A3.4 3.4 0 1 0 8 4.6z",
  step: "M2.5 2.5v11l8-5.5zM11 2.5h2.5v11H11z",
  back: "M13.5 2.5v11l-8-5.5zM5 2.5H2.5v11H5z",
  expand: "M2 2h5v2H4v3H2zM14 2v5h-2V4H9V2zM2 14V9h2v3h3v2zM14 14H9v-2h3V9h2z",
  collapse: "M7 2v5H2V5h3V2zM9 2h2v3h3v2H9zM2 9h5v5H5v-3H2zM9 9h5v2h-3v3H9z",
  shuffle: "M1.5 4h3l6 8h3M1.5 12h3l1.6-2.1M9.4 5.9 10.5 4h3M12 2l2 2-2 2M12 10l2 2-2 2",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  const stroke = name === "shuffle";
  return (
    <svg className="sim-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d={paths[name]}
        fill={stroke ? "none" : "currentColor"}
        stroke={stroke ? "currentColor" : "none"}
        strokeWidth={stroke ? 1.6 : 0}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
