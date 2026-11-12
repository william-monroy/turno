import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../../core/config.js";
import { tildify } from "../../core/paths.js";
import { resolveProfile } from "../../core/resolve.js";
import { type Command, fail } from "../io.js";

export const command: Command = {
  summary: "which account auto would use in a folder, and why",
  usage: "Usage: turno which [dir]\n\nExplains the profile resolution for a folder (default: the current one).",
  async run(args, io) {
    const dir = resolvePath(args[0] ?? process.cwd());
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) fail(`no such folder: ${args[0] ?? dir}`);
    const r = resolveProfile(dir, loadConfig(io.env), io.env);
    io.out(tildify(dir, io.env));
    io.out(`  assigned: ${r.assigned || "none"} (${r.reason})`);
    io.out(r.note ? `  using now: ${r.chosen} (${r.assigned} ${r.note})` : `  using now: ${r.chosen || "plain claude"}`);
    return 0;
  },
};
