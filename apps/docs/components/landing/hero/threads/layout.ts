import { CURTAINS } from "./shaders";

/**
 * The composition. Units are page heights with y up (0 at the bottom of the hero, 1 at its top);
 * `u` runs from 0 to 1 across the width. The copy sits low and left, so the thread comes in high
 * on the left, over open sky, and falls gently to the right through the three curtains, each of
 * which hangs from above with its hem a little under the thread.
 */

export const ACCOUNTS = ["work", "client", "personal"] as const;
export type Account = (typeof ACCOUNTS)[number];
/** The tone token of each account, in curtain order. */
export const TONES = ["work", "third", "personal"] as const;

export interface Scene {
  /** The thread: y = a + b u + c u^2. */
  thread: [number, number, number];
  /** Per curtain: centre u, half width u, edge softness u, drift u. */
  span: Float32Array;
  /** Per curtain: hem depth under the thread, ray height, brightness, hem tilt. */
  body: Float32Array;
  /** Per curtain: fold depth, fold wavenumber, fold speed, phase. */
  fold: Float32Array;
  /** How strongly each curtain answers the pointer. */
  reach: number[];
  /**
   * Past the copy the curtains hang longer: from `u` = sag[0] to sag[1] every hem drops by up to
   * sag[2] page heights, the same for all of them, so the band stays one band. sag[3] is the
   * floor, in page heights from the bottom, above which the low cloth fades out.
   */
  sag: [number, number, number, number];
}

interface Curtain {
  span: [number, number, number, number];
  body: [number, number, number, number];
  fold: [number, number, number, number];
  reach: number;
}

interface Composition {
  thread: [number, number, number];
  curtains: Curtain[];
}

/*
 * A wide screen: one long band of light under the thread, in three accounts' tones, taking the
 * top and the right. Every hem sits the same depth under the thread at the same `u`, so the three
 * curtains read as one aurora that changes color where it changes account.
 */
const WIDE: Composition = {
  thread: [0.93, -0.12, -0.3],
  curtains: [
    { span: [0.44, 0.14, 0.04, 0.01], body: [0.07, 0.4, 0.95, 0.09], fold: [0.04, 14, 0.16, 0.4], reach: 1 },
    { span: [0.69, 0.12, 0.04, 0.01], body: [0.07, 0.46, 1.25, 0.09], fold: [0.044, 13, -0.14, 2.3], reach: 1 },
    { span: [0.94, 0.14, 0.04, 0.01], body: [0.07, 0.52, 1.05, 0.09], fold: [0.046, 12, 0.12, 4.1], reach: 1 },
  ],
};

/* A phone: the band crosses the top of the screen almost level, over the copy. */
const TALL: Composition = {
  thread: [0.86, -0.07, -0.05],
  curtains: [
    { span: [0.15, 0.18, 0.05, 0.01], body: [0.06, 0.24, 0.95, 0.03], fold: [0.014, 30, 0.16, 0.4], reach: 1 },
    { span: [0.5, 0.16, 0.05, 0.01], body: [0.06, 0.26, 1.1, 0.03], fold: [0.016, 28, -0.14, 2.3], reach: 1 },
    { span: [0.85, 0.18, 0.05, 0.01], body: [0.06, 0.28, 1.05, 0.03], fold: [0.018, 26, 0.12, 4.1], reach: 1 },
  ],
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function createScene(): Scene {
  return {
    thread: [0.9, -0.16, -0.26],
    span: new Float32Array(CURTAINS * 4),
    body: new Float32Array(CURTAINS * 4),
    fold: new Float32Array(CURTAINS * 4),
    reach: [1, 1, 1],
    sag: [1, 1.1, 0, 0],
  };
}

/** Blends the phone and wide compositions by aspect ratio, so every width in between holds. */
export function layoutScene(scene: Scene, aspect: number): void {
  const t = Math.min(1, Math.max(0, (aspect - 0.6) / (1.55 - 0.6)));
  const k = t * t * (3 - 2 * t);
  scene.sag[2] = 0;
  for (let j = 0; j < 3; j++) scene.thread[j] = lerp(TALL.thread[j], WIDE.thread[j], k);
  for (let i = 0; i < CURTAINS; i++) {
    const a = TALL.curtains[i];
    const b = WIDE.curtains[i];
    for (let j = 0; j < 4; j++) {
      scene.span[i * 4 + j] = lerp(a.span[j], b.span[j], k);
      scene.body[i * 4 + j] = lerp(a.body[j], b.body[j], k);
      scene.fold[i * 4 + j] = lerp(a.fold[j], b.fold[j], k);
    }
    scene.reach[i] = lerp(a.reach, b.reach, k);
  }
}

/**
 * Keeps the band clear of the copy. `top` is the top of the words (page heights from the
 * bottom) and `right` how far across they reach (0 to 1); `labels` holds where each account's
 * name hangs (u), and `room` how much space a name needs under its hem. At rest the whole band,
 * names included, sits above the line of the words all the way across, so it reads as one sky
 * over the headline; only past the copy does it hang lower (see `hangRight`). When it would come
 * down too far, the whole sky is squeezed toward the top edge: the band keeps its shape.
 */
export function fitAbove(scene: Scene, top: number, right: number, labels: number[], room: number): void {
  if (top <= 0) return;
  let k = 1;
  for (let i = 0; i < CURTAINS; i++) {
    const u = labels[i] ?? 0;
    // A name follows its hem as the folds swing it, so it needs room for the lowest swing too.
    const swing = (scene.fold[i * 4] ?? 0) * 0.8;
    k = Math.min(k, (1 - top - 0.008 - room) / Math.max(0.01, 1 - hemY(scene, i, u) + swing));
  }
  // The hem itself may brush the words, where the calm zone dims it.
  const r = Math.min(Math.max(right, 0.2), 0.75);
  k = Math.max(0.5, Math.min(k, (1 - top + 0.035) / Math.max(0.01, 1 - hemY(scene, 0, r))));
  if (k >= 1) return;
  scene.thread[0] = 1 - (1 - scene.thread[0]) * k;
  scene.thread[1] *= k;
  scene.thread[2] *= k;
  for (let i = 0; i < CURTAINS; i++) {
    const o = i * 4;
    scene.body[o] = (scene.body[o] ?? 0) * k;
    scene.body[o + 1] = (scene.body[o + 1] ?? 0) * k;
    scene.body[o + 3] = (scene.body[o + 3] ?? 0) * k;
    scene.fold[o] = (scene.fold[o] ?? 0) * k;
  }
}

/**
 * Lets the curtains hang down into the open space right of the copy. `from` is where the copy
 * ends (0 to 1 across) and `floor` the lowest a hem may come, in page heights from the bottom,
 * so the cloth fades out above the rail and leaves room for a name under it.
 */
export function hangRight(scene: Scene, from: number, floor: number): void {
  scene.sag[0] = from;
  scene.sag[1] = Math.min(1.02, from + 0.42);
  scene.sag[2] = 0;
  scene.sag[3] = floor;
  if (from > 0.8) return;
  // The deepest hem at the right edge sets how far all of them may drop.
  const edge = Math.min(hemY(scene, 2, 1), hemY(scene, 2, scene.sag[1]));
  scene.sag[2] = Math.max(0, edge - floor);
}

function sagAt(scene: Scene, u: number): number {
  const [from, to, depth] = scene.sag;
  if (depth <= 0) return 0;
  const t = Math.min(1, Math.max(0, (u - from) / Math.max(0.01, to - from)));
  return depth * t * t * (3 - 2 * t);
}

export function threadY(scene: Scene, u: number): number {
  const [a, b, c] = scene.thread;
  return a + b * u + c * u * u;
}

/** The resting hem of a curtain at `u`, the same line the field shader draws. */
export function hemY(scene: Scene, curtain: number, u: number): number {
  const o = curtain * 4;
  return threadY(scene, u) - (scene.body[o] ?? 0) - (scene.body[o + 3] ?? 0) * u - sagAt(scene, u);
}

/** The hem as it is drawn right now, folds and cloth included, for labels that ride on it. */
export function liveHemY(scene: Scene, curtain: number, u: number, aspect: number, time: number, drop: number, lift: number): number {
  const o = curtain * 4;
  const x = u * aspect;
  const depth = scene.fold[o] ?? 0;
  const k = scene.fold[o + 1] ?? 0;
  const speed = scene.fold[o + 2] ?? 0;
  const phase = scene.fold[o + 3] ?? 0;
  const a1 = k * x - speed * time + phase;
  const a3 = 0.43 * k * x - 0.6 * speed * time + phase * 0.7;
  const a2 = 2.31 * k * x + 1.37 * speed * time + phase * 1.9;
  return hemY(scene, curtain, u) + drop + lift + depth * (0.45 * Math.cos(a3) + 0.5 * Math.cos(a1) + 0.22 * Math.cos(a2));
}

/** Which curtain is over `u`, if any: the one whose span holds it, nearest centre first. */
export function curtainAt(scene: Scene, u: number): number {
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CURTAINS; i++) {
    const gap = Math.abs(u - scene.span[i * 4]);
    if (gap <= scene.span[i * 4 + 1] + scene.span[i * 4 + 2] * 0.5 && gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}
