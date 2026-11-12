import { isValidProfileName } from "../../core/config.js";
import { markExhausted } from "../../core/exhausted.js";
import { formatUntil } from "../../core/resolve.js";
import { type Command, fail } from "../io.js";
import { launcherPath } from "../launch.js";

const USAGE = 'Usage: turno exhausted <profile> [until "YYYY-MM-DD HH:MM"]';

/** Local "YYYY-MM-DD HH:MM" to epoch seconds. */
export function parseLocalDateTime(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h) return undefined;
  return Math.floor(dt.getTime() / 1000);
}

export const command: Command = {
  summary: "send a profile's projects to the fallback (default for 5 h)",
  usage: `${USAGE}\n\nMarks the profile exhausted until the given local time (default: now + 5 h).`,
  async run(args, io) {
    const name = args[0];
    if (!name || !isValidProfileName(name) || !launcherPath(name, io.env)) fail(USAGE.replace("Usage: ", "usage: "));
    let until: number;
    if (args[1] === "until" && args[2]) {
      const t = parseLocalDateTime(args[2]);
      if (t === undefined) fail(`invalid date: ${args[2]} (format YYYY-MM-DD HH:MM)`);
      until = t;
    } else {
      until = Math.floor(Date.now() / 1000) + 5 * 3600;
    }
    markExhausted(name, until, io.env);
    io.out(`${name} exhausted until ${formatUntil(until)}; its projects open with the fallback`);
    return 0;
  },
};
