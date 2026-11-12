import { type Config, loadConfig } from "../../core/config.js";
import { resolveProfile } from "../../core/resolve.js";
import type { Command } from "../io.js";
import { execCommand, execLauncher, launcherPath } from "../launch.js";

export const command: Command = {
  summary: "open Claude Code with the account assigned to this folder (turno-auto)",
  usage: [
    "Usage: turno auto [claude args]",
    "",
    "Resolves the profile for the current folder (a git worktree counts as its main",
    "repository), switches to the fallback when the assigned profile is exhausted, and",
    "execs its launcher. Without a profile, runs plain `claude`.",
  ].join("\n"),
  async run(args, io) {
    let config: Config | undefined;
    try {
      config = loadConfig(io.env);
    } catch (err) {
      // A broken config must not stop Claude Code from starting.
      io.err(`turno: ${(err as Error).message}; running plain claude`);
    }
    const r = config ? resolveProfile(process.cwd(), config, io.env) : undefined;
    const launcher = r?.chosen ? launcherPath(r.chosen, io.env) : undefined;
    if (!r || !launcher) return execCommand("claude", args, io.env);
    if (process.stderr.isTTY && args[0] !== "--version" && args[0] !== "-v") {
      io.err(r.note ? `turno: ${r.assigned} ${r.note} → using ${r.chosen} (${r.reason})` : `turno: account ${r.chosen} (${r.reason})`);
    }
    return execLauncher(launcher, args, io.env);
  },
};
