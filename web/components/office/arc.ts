/** Handoff packet flight path. Pure, so it can be unit tested without three.js. */

export interface Flight {
  from: [number, number, number];
  to: [number, number, number];
  start: number;
  duration: number;
  height: number;
}

/** Position along a parabolic arc at progress u in [0, 1] (ease-in-out). */
export function arcPoint(f: Flight, u: number): [number, number, number] {
  const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
  return [
    f.from[0] + (f.to[0] - f.from[0]) * e,
    f.from[1] + (f.to[1] - f.from[1]) * e + Math.sin(Math.PI * e) * f.height,
    f.from[2] + (f.to[2] - f.from[2]) * e,
  ];
}
