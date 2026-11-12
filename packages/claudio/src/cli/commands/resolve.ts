import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../../core/config.js";
import { resolveProfile } from "../../core/resolve.js";
import type { Command } from "../io.js";

/** Field separator of the machine output read by status lines. */
export const SEP = "\x1f";

export const command: Command = {
  summary: "machine-readable resolution for status lines",
  usage: [
    "Usage: claudio resolve [dir] [--json]",
    "",
    "Prints chosen, assigned, reason and note separated by \\x1f on one line,",
    "or a JSON object with --json.",
  ].join("\n"),
  hidden: true,
  async run(args, io) {
    const json = args.includes("--json");
    const dir = args.find((a) => a !== "--json");
    const r = resolveProfile(resolvePath(dir ?? process.cwd()), loadConfig(io.env), io.env);
    io.out(json ? JSON.stringify(r) : [r.chosen, r.assigned, r.reason, r.note].join(SEP));
    return 0;
  },
};
