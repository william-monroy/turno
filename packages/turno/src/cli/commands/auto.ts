import { type AgentId, adapter, isAgentId } from "../../agents/index.js";
import { type Config, loadConfig } from "../../core/config.js";
import { resolveProfile } from "../../core/resolve.js";
import { type Command, fail } from "../io.js";
import { execCommand, execLauncher, launcherPath } from "../launch.js";

export const command: Command = {
  summary: "open the agent with the account assigned to this folder (turno-auto)",
  usage: [
    "Usage: turno auto [--agent claude|codex|copilot|cursor] [agent args]",
    "",
    "Resolves the profile of that agent (Claude Code by default) for the current folder (a",
    "git worktree counts as its main repository), switches to the fallback when one is set and",
    "the assigned profile is exhausted, and execs its launcher. Without a profile, runs the",
    "agent's own command (claude, codex, copilot, cursor-agent).",
  ].join("\n"),
  async run(argv, io) {
    let agent: AgentId = "claude";
    let args = argv;
    if (argv[0] === "--agent" || argv[0]?.startsWith("--agent=")) {
      const v = argv[0] === "--agent" ? argv[1] : argv[0].slice("--agent=".length);
      if (!isAgentId(v)) return fail("--agent must be claude, codex, copilot or cursor");
      agent = v;
      args = argv.slice(argv[0] === "--agent" ? 2 : 1);
    }
    let config: Config | undefined;
    try {
      config = loadConfig(io.env);
    } catch (err) {
      // A broken config must not stop Claude Code from starting.
      io.err(`turno: ${(err as Error).message}; running plain ${adapter(agent).command}`);
    }
    const r = config ? resolveProfile(process.cwd(), config, io.env, undefined, agent) : undefined;
    const launcher = r?.chosen ? launcherPath(r.chosen, io.env, agent) : undefined;
    if (!r || !launcher) return execCommand(adapter(agent).command, args, io.env);
    if (process.stderr.isTTY && args[0] !== "--version" && args[0] !== "-v") {
      io.err(r.note ? `turno: ${r.assigned} ${r.note} → using ${r.chosen} (${r.reason})` : `turno: account ${r.chosen} (${r.reason})`);
    }
    return execLauncher(launcher, args, io.env);
  },
};
