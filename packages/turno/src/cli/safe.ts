/**
 * Safe mode: `turno run <profile> --no-gateway`, `turno auto --no-gateway` or TURNO_SAFE=1.
 * The agent opens with the profile's account, as its launcher would set it up, but without the
 * gateway: no mcpd entries, no gateway token, no session headers, and (Claude Code) no status
 * line. When a problem goes away in safe mode, it comes from turno's gateway or status line;
 * when it stays, it does not. How each agent leaves the entries out is in docs/agents.md.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SafePlan } from "../agents/adapter.js";
import { type AgentId, adapter, agentProfileDir } from "../agents/index.js";
import { ensurePrivateDir, paths, tildify } from "../core/paths.js";
import { Exit } from "./exit.js";
import { CliError, type Io } from "./io.js";
import { execLauncher } from "./launch.js";
import { findOnPath, launcherBrowser } from "./launchers.js";

/** The flag that asks for safe mode, taken out of the agent's arguments. */
const SAFE_FLAG = "--no-gateway";

/** `--no-gateway` out of the arguments (only turno's, before a `--`), and whether it was there. */
export function takeSafeFlag(args: readonly string[]): { args: string[]; safe: boolean } {
  const end = args.indexOf("--");
  const head = end < 0 ? [...args] : args.slice(0, end);
  const tail = end < 0 ? [] : args.slice(end);
  const kept = head.filter((a) => a !== SAFE_FLAG);
  return { args: [...kept, ...tail], safe: kept.length !== head.length };
}

/** Variables a launcher sets for the gateway, which safe mode leaves out. */
const GATEWAY_VARS = ["TURNO_MCPD_TOKEN", "TURNO_SESSION_PID", "TURNO_SESSION_CWD_B64"];

/**
 * The safe-mode arguments of an agent for the MCP file it reads (a profile's or the hub's): the
 * adapter's `safeMode` (src/agents), with a private scratch file under the state folder.
 */
export function safePlan(agent: AgentId, file: string, cwd: string, env: NodeJS.ProcessEnv, key: string): SafePlan {
  const dir = ensurePrivateDir(join(paths(env).state, "safe"), env);
  return adapter(agent).safeMode({ file, cwd, env, scratch: join(dir, `${key}.mcp.json`) });
}

/**
 * The environment a launcher gives `profile` (ADR 0032), without the gateway variables, and with
 * TURNO_SAFE=1 so a turno the agent runs stays in safe mode. Without a profile: the plain agent.
 */
export function safeEnv(agent: AgentId, profile: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const a = adapter(agent);
  const out: NodeJS.ProcessEnv = { ...env, TURNO_SAFE: "1" };
  for (const v of GATEWAY_VARS) delete out[v];
  if (!profile) return out;
  out[a.homeEnv] = agentProfileDir(profile, agent, env);
  out.TURNO_PROFILE = profile;
  if (!a.classicLauncher) out.TURNO_AGENT = agent;
  Object.assign(out, a.launcherEnv);
  const browser = launcherBrowser(env, platform);
  if (browser) out.BROWSER = browser;
  return out;
}

/**
 * Open `profile` (or the plain agent) in safe mode: the agent's own command with the profile's
 * environment, never the launcher, which would export the gateway token. The run record is
 * written as the launcher writes it, so turno sessions still knows the account.
 */
export async function launchSafe(agent: AgentId, profile: string | undefined, args: string[], io: Io, cwd = process.cwd()): Promise<number> {
  const a = adapter(agent);
  const bin = findOnPath(a.command, io.env);
  if (!bin) throw new CliError(`${a.command} is not installed (${a.install})`, Exit.notInstalled);
  if (profile && !existsSync(agentProfileDir(profile, agent, io.env))) {
    throw new CliError(`profile ${profile} has no folder (${tildify(agentProfileDir(profile, agent, io.env), io.env)}). Run: turno profile repair ${profile}`);
  }
  const configFile = profile ? a.mcp.file(agentProfileDir(profile, agent, io.env), io.env) : a.mcp.hubFile(io.env);
  const plan = safePlan(agent, configFile, cwd, io.env, profile ?? `plain-${agent}`);
  io.err(`turno: safe mode, ${profile ? `profile ${profile}` : `plain ${a.command}`} without the gateway (${SAFE_FLAG} or TURNO_SAFE=1)`);
  for (const n of plan.notes) io.err(`  ${n}`);
  // execve keeps this PID, as the launcher's exec does; a child process would have another.
  if (profile && typeof process.execve === "function") {
    try {
      const run = ensurePrivateDir(paths(io.env).runDir, io.env);
      writeFileSync(join(run, String(process.pid)), `${profile}\n`);
    } catch {
      /* turno sessions shows it as unknown */
    }
  }
  return execLauncher(bin, [...plan.args, ...args], safeEnv(agent, profile, io.env));
}
