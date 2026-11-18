/**
 * Durations and sizes as people write them in identity.json and on the command line:
 * `"15m"`, `"90s"`, `"250ms"`, `"1h"` and `"0"`; `"100MB"`, `"512KB"`, `"1GB"`.
 */

const TIME: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const SIZE: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** Milliseconds of a duration like `"15m"`, `"90s"`, `"250ms"`, `"1h"` or `"0"`; undefined when it is not one. */
export function parseDuration(value: string): number | undefined {
  const v = value.trim();
  if (v === "0") return 0;
  const m = /^(\d+)(ms|s|m|h)$/.exec(v);
  return m ? Number(m[1]) * TIME[m[2]!]! : undefined;
}

/** Bytes of a size like `"100MB"`, `"512KB"`, `"1GB"` (case does not matter); undefined when it is not one. */
export function parseSize(value: string): number | undefined {
  const m = /^(\d+)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  return m ? Number(m[1]) * SIZE[m[2]!.toLowerCase()]! : undefined;
}
