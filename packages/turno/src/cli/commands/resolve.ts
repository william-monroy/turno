import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../../core/config.js";
import { resolveProfile } from "../../core/resolve.js";
import { JSON_FLAG, bool, flagsOf, parseFlags } from "../args.js";
import type { Command } from "../io.js";
import { emitLine, jsonOutput } from "../output.js";

/** `turno resolve --json`: one line, read by status lines. */
const RESOLVE_JSON = jsonOutput(["chosen", "assigned", "reason", "note", "exhaustedUntil"]);

/** Field separator of the machine output read by status lines. */
export const SEP = "\x1f";

export const command: Command = {
  summary: "machine-readable resolution for status lines",
  usage: [
    "Usage: turno resolve [dir] [--json]",
    "",
    "Prints chosen, assigned, reason and note separated by \\x1f on one line,",
    "or a JSON object with --json.",
  ].join("\n"),
  hidden: true,
  args: ["dir"],
  flags: flagsOf(JSON_FLAG),
  json: RESOLVE_JSON,
  async run(args, io) {
    const p = parseFlags(args, JSON_FLAG, 1);
    const json = bool(p, "json");
    const dir = p.positionals[0];
    const r = resolveProfile(resolvePath(dir ?? process.cwd()), loadConfig(io.env), io.env);
    if (json) emitLine(io, p, RESOLVE_JSON, r);
    else io.out([r.chosen, r.assigned, r.reason, r.note].join(SEP));
    return 0;
  },
};
