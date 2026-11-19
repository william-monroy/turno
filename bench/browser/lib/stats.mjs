// Small statistics for paired A/B runs: medians, the run order, paired differences and a
// bootstrap interval. Pure functions, so the unit tests pin them down.

/** The median of a list of numbers (NaN for an empty list). */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return Number.NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * The order of every run: for each round, every task in the given order, and for each task
 * both configs. The config that goes first alternates from one round to the next (A B, then
 * B A), so a slow start, a warm disk cache or a machine that heats up weighs on both sides
 * the same.
 */
export function schedule(tasks, configs, rounds) {
  const out = [];
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? configs : [...configs].reverse();
    for (const task of tasks) for (const config of order) out.push({ round, task, config });
  }
  return out;
}

/** A seeded pseudo-random generator (mulberry32), so a report can be recomputed exactly. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 95% percentile bootstrap interval for the median of paired differences, or undefined with
 * fewer than five pairs (the interval would mean nothing).
 */
export function bootstrapMedian(diffs, { resamples = 2000, seed = 1 } = {}) {
  const d = diffs.filter((x) => Number.isFinite(x));
  if (d.length < 5) return undefined;
  const rand = seeded(seed);
  const medians = [];
  for (let i = 0; i < resamples; i++) {
    const sample = d.map(() => d[Math.floor(rand() * d.length)]);
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(resamples * 0.025)], medians[Math.ceil(resamples * 0.975) - 1]];
}

/**
 * Paired comparison of one metric: pairs are runs of the same task in the same round, one per
 * config. Returns the medians of each side, the median of the differences (B minus A), that
 * difference relative to A's median, how many pairs B was lower and higher, and the interval.
 */
export function paired(pairs, { seed = 1 } = {}) {
  const a = pairs.map((p) => p.a);
  const b = pairs.map((p) => p.b);
  const diffs = pairs.map((p) => p.b - p.a).filter((x) => Number.isFinite(x));
  const medA = median(a);
  const delta = median(diffs);
  return {
    n: diffs.length,
    a: medA,
    b: median(b),
    delta,
    relative: Number.isFinite(delta) && medA ? delta / medA : undefined,
    lower: diffs.filter((x) => x < 0).length,
    higher: diffs.filter((x) => x > 0).length,
    interval: bootstrapMedian(diffs, { seed }),
  };
}

/** Results bytes as an estimate of tokens: about four bytes per token for English and markup. */
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}
