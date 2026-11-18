import { join } from "node:path";
import { AGENT_IDS, type AgentId, DEFAULT_AGENT, adapter, agentHub, isAgentId } from "../../agents/index.js";
import { type Config, loadConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { resolveProfile } from "../../core/resolve.js";
import { Exit } from "../exit.js";
import { CliError, type Command, type Io, fail } from "../io.js";
import { execLauncher, findOnPath, launcherPath, wantsSafe } from "../launch.js";
import { launcherName } from "../launchers.js";

/** What `turno auto` will exec, and the line it tells the person on stderr. */
export interface AutoPlan {
  file: string;
  /** The agent it opens, and the profile (none for the plain agent): what safe mode needs. */
  agent: AgentId;
  profile?: string;
  args: string[];
  notice?: string;
  /** Show the notice even when stderr is not a terminal. */
  always?: boolean;
}

/**
 * Decide what `turno auto` runs in `cwd`. It never falls back to another account in silence:
 * a chosen profile without its launcher, a rule naming a missing profile, or a broken
 * config.toml are errors (TURNO_ALLOW_PLAIN=1 runs the plain agent despite a broken config).
 */
export function planAuto(argv: string[], io: Io, cwd: string = process.cwd()): AutoPlan {
  let agent: AgentId = DEFAULT_AGENT;
  let args = argv;
  if (argv[0] === "--agent" || argv[0]?.startsWith("--agent=")) {
    const v = argv[0] === "--agent" ? argv[1] : argv[0].slice("--agent=".length);
    if (!isAgentId(v)) return fail(`--agent must be ${AGENT_IDS.slice(0, -1).join(", ")} or ${AGENT_IDS.at(-1)}`);
    agent = v;
    args = argv.slice(argv[0] === "--agent" ? 2 : 1);
  }
  const env = io.env;
  const a = adapter(agent);
  const hub = tildify(agentHub(agent, env), env);
  const plain = (): string => {
    const file = findOnPath(a.command, env);
    if (!file) throw new CliError(`${a.command} is not installed (${a.install})`, Exit.notInstalled);
    return file;
  };
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const msg = (err as Error).message;
    if (env.TURNO_ALLOW_PLAIN === "1")
      return {
        file: plain(),
        agent,
        args,
        notice: `turno: ${msg}; running plain ${a.command} (TURNO_ALLOW_PLAIN=1)`,
        always: true,
      };
    throw new CliError(
      `${msg}\nturno auto does not guess an account while config.toml is broken. Fix it (turno config edit), or run plain ${a.command} once with TURNO_ALLOW_PLAIN=1.`,
    );
  }
  const where = tildify(cwd, env);
  const r = resolveProfile(cwd, config, env, undefined, agent);
  if (r.chosen) {
    const launcher = launcherPath(r.chosen, env, agent);
    if (!launcher) {
      if (!listProfiles(config, env).includes(r.chosen)) {
        const add = `turno profile add ${r.chosen}${agent === DEFAULT_AGENT ? "" : ` --agent ${agent}`}`;
        throw new CliError(
          `${where} uses the ${r.chosen} profile (${r.reason}), but there is no such profile. Run: ${add}, or change the rule (turno profile which)`,
          Exit.noProfile,
        );
      }
      const missing = tildify(join(paths(env).bin, launcherName(r.chosen, agent)), env);
      throw new CliError(
        `${where} uses the ${r.chosen} profile, but its launcher ${missing} is missing. Run: turno profile repair ${r.chosen}`,
      );
    }
    return {
      file: launcher,
      agent,
      profile: r.chosen,
      args,
      notice: r.note
        ? `turno: ${r.assigned} ${r.note} → using ${r.chosen} (${r.reason})`
        : `turno: account ${r.chosen} (${r.reason})`,
    };
  }
  if (config.system === "") {
    throw new CliError(
      `${where} has no rule and no default profile, and system = "" says there is no default account. Assign one: turno profile assign ${where} <profile>`,
      Exit.noProfile,
    );
  }
  if (agent !== DEFAULT_AGENT && listProfiles(config, env, agent).length === 0) {
    return {
      file: plain(),
      agent,
      args,
      notice: `turno: no ${a.label} profile yet, so this runs plain ${a.command} with ${hub} (turno profile add <name> --agent ${agent})`,
      always: true,
    };
  }
  return {
    file: plain(),
    agent,
    args,
    notice: `turno: no rule or default for ${where}; running plain ${a.command} with ${hub}`,
  };
}

export const command: Command = {
  summary: "open the agent with the account assigned to this folder (turno-auto)",
  usage: [
    "Usage: turno auto [--agent <agent>] [--no-gateway] [agent args]",
    "",
    "<agent> is claude (the default), codex, copilot or cursor.",
    "",
    "Resolves the profile of that agent (Claude Code by default) for the current",
    "folder (a git worktree counts as its main repository), switches to the fallback",
    "when one is set and the assigned profile is exhausted, and execs its launcher.",
    "Without a rule or a default, runs the agent's own command (claude, codex,",
    "copilot, cursor-agent).",
    "",
    "It never switches accounts in silence: it exits 3 when the folder's profile does",
    'not exist (or there is no rule and system = ""), 1 when its launcher is missing',
    "or config.toml does not parse, and says how to fix it (turno help exit-codes).",
    "TURNO_ALLOW_PLAIN=1 runs the plain agent despite a broken config.toml;",
    'system = "" in config.toml makes folders without a rule an error too.',
    "",
    "--no-gateway (or TURNO_SAFE=1) opens the same account in safe mode: no mcpd",
    "entries and no status line, to tell whether a problem comes from turno (turno",
    "run --help).",
    "",
    "Examples:",
    "  $ turno auto",
    "  $ turno auto --resume",
    "  $ turno auto --agent codex",
    "  $ turno auto --no-gateway",
  ].join("\n"),
  async run(argv, io) {
    const safe = wantsSafe(argv, io.env);
    const plan = planAuto(safe ? (await import("../safe.js")).takeSafeFlag(argv).args : argv, io);
    const quiet = plan.args[0] === "--version" || plan.args[0] === "-v";
    if (plan.notice && (plan.always || (process.stderr.isTTY && !quiet))) io.err(plan.notice);
    if (safe) return (await import("../safe.js")).launchSafe(plan.agent, plan.profile, plan.args, io);
    return execLauncher(plan.file, plan.args, io.env);
  },
};
