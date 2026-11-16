import { loadConfig } from "../../core/config.js";
import { tildify } from "../../core/paths.js";
import { displayName, liveSessions } from "../../core/sessions.js";
import { parseFlags } from "../args.js";
import type { Command } from "../io.js";

export const command: Command = {
  summary: "list live sessions and the account of each",
  usage: "Usage: turno sessions",
  async run(args, io) {
    parseFlags(args, {}, 0);
    const config = loadConfig(io.env);
    const rows = liveSessions(io.env, config).map((s) => {
      const account =
        s.source === "desktop"
          ? "Claude Desktop (its own account)"
          : s.source === "record"
            ? s.profile!
            : `plain claude (~/.claude${config.system ? ` = ${config.system}` : ""})`;
      return { name: displayName(s), account, status: s.status, cwd: tildify(s.cwd, io.env) };
    });
    if (rows.length === 0) {
      io.out("No live sessions.");
      return 0;
    }
    const w = Math.max(6, ...rows.map((r) => r.name.length));
    for (const r of rows) io.out(`${r.name.padEnd(w)}  ${r.account.padEnd(34)}  ${r.status.padEnd(6)}  ${r.cwd}`);
    return 0;
  },
};
