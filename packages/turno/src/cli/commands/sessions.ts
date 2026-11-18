import { loadConfig } from "../../core/config.js";
import { tildify } from "../../core/paths.js";
import { displayName, liveSessions, parseProcStart } from "../../core/sessions.js";
import { parseFlags } from "../args.js";
import type { Command } from "../io.js";
import { profileColor, style } from "../style.js";

/** "45s", "12m", "3h05m", "2d 4h": how long a session has been running. */
function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const command: Command = {
  summary: "list live sessions and the account of each",
  usage: "Usage: turno sessions",
  async run(args, io) {
    parseFlags(args, {}, 0);
    const config = loadConfig(io.env);
    const s = style(io);
    const pill = (name: string) => s.profile(name, profileColor(config.profiles, name));
    const now = Date.now();
    const rows = liveSessions(io.env, config).map((x) => {
      const account =
        x.source === "desktop"
          ? s.muted("Claude Desktop (its own account)")
          : x.source === "record"
            ? pill(x.profile!)
            : s.color
              ? `${s.muted("plain claude")}${config.system ? ` ${pill(config.system)}` : ""}`
              : `plain claude (~/.claude${config.system ? ` = ${config.system}` : ""})`;
      const start = parseProcStart(x.procStart ?? "");
      // Claude Code writes procStart in UTC; a reading in the future means it is local time.
      const began = start ? (start.utc <= now + 60_000 ? start.utc : start.local) : undefined;
      const status = x.status === "busy" ? s.warn(x.status) : x.status === "idle" ? s.ok(x.status) : x.status;
      return [
        s.bold(displayName(x)),
        account,
        status,
        s.muted(began !== undefined ? age(now - began) : "?"),
        s.muted(tildify(x.cwd, io.env)),
      ];
    });
    if (rows.length === 0) {
      io.out("No live sessions.");
      return 0;
    }
    if (!s.color) {
      for (const line of s.table(rows, { indent: 0 })) io.out(line);
      return 0;
    }
    io.out(s.header("Sessions"));
    for (const line of s.table(rows, { columns: [{}, {}, {}, { align: "right", drop: 1 }, {}] })) io.out(line);
    return 0;
  },
};
