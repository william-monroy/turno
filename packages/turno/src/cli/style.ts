// The look moved to turno-core so turno-browser shares it; profile colors stay with the status line.
import { NAMED_COLORS, PILL_DEFAULTS } from "../statusline/render.js";

export * from "turno-core/cli/style";

/**
 * The 256-color code of a profile: its `color` in config.toml, or one of the defaults by its
 * place in the config. The one rule for every profile pill: the status line (`pillColor` in
 * statusline.ts) calls this too, and the color tables are the status line's (render.ts).
 */
export function profileColor(profiles: Record<string, { color?: string | number }>, name: string): number {
  const c = profiles[name]?.color;
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    if (/^\d+$/.test(c)) return Number(c);
    const named = NAMED_COLORS[c.toLowerCase()];
    if (named !== undefined) return named;
  }
  const names = Object.keys(profiles);
  const idx = names.includes(name) ? names.indexOf(name) : [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return PILL_DEFAULTS[idx % PILL_DEFAULTS.length]!;
}
