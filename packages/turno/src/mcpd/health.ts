import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT, adapter, mcpFileFor } from "../agents/index.js";
import type { Io } from "../cli/io.js";
import { loadConfig } from "../core/config.js";
import { paths, tildify } from "../core/paths.js";
import { agentOf, listProfiles } from "../core/profiles.js";
import { profileTokenFile, tokenProfile } from "./tokens.js";
import { isRecord, readState } from "../core/state-file.js";

/**
 * The mcpd part of `turno doctor`: the service file and the paths it runs, the
 * token's mode, who answers on the port, why mcpd is down, the manifest it serves, and
 * whether synced profiles point at the port mcpd uses.
 */
export interface McpdCheck {
  level: "ok" | "warn" | "fail" | "info";
  text: string;
  /** A repair `turno doctor --fix` runs; its label is the command a person would type. */
  fix?: { label: string; run(io: Io): Promise<unknown> | unknown };
  /** A command that fixes it, which a person runs (doctor --fix does not). */
  hint?: string;
  /** The manual step, when no single command fixes it. */
  manual?: string;
}

const startFix = {
  label: "turno mcp daemon start",
  run: async (io: Io) => (await import("../cli/commands/mcpd.js")).installDaemonService(io),
};

const syncFix = {
  label: "turno mcp sync",
  run: async (io: Io) => (await import("../cli/commands/mcp.js")).command.run(["sync"], io),
};

/** Ports the gateway URLs in a synced config file point at. */
export function syncedPorts(text: string): number[] {
  return [...new Set([...text.matchAll(/127\.0\.0\.1:(\d+)\/mcp\//g)].map((m) => Number(m[1])))];
}

async function serviceChecks(env: NodeJS.ProcessEnv): Promise<McpdCheck[]> {
  const { installedBackend, isUnstablePath } = await import("./service.js");
  const backend = await installedBackend(env);
  if (!backend) return [];
  const file = backend.file(env);
  const text = readFileSync(file, "utf8");
  const program = backend.programOf(text);
  const shown = tildify(file, env);
  const out: McpdCheck[] = [];
  const missing = program.filter((a) => a.startsWith("/") && !existsSync(a));
  if (!program.length) out.push({ level: "fail", text: `mcpd: ${shown} has no program to run`, fix: startFix });
  else if (missing.length)
    out.push({
      level: "fail",
      text: `mcpd: ${shown} runs ${missing.map((m) => tildify(m, env)).join(", ")}, which no longer exists`,
      fix: startFix,
    });
  else if (program.some((a) => a.startsWith("/") && isUnstablePath(a))) {
    out.push({
      level: "warn",
      text: `mcpd: ${shown} runs a versioned path (${tildify(program[0]!, env)}) that breaks when that version is removed`,
      fix: startFix,
    });
  } else out.push({ level: "ok", text: `mcpd: ${backend.noun} ${shown}` });
  if (backend.kind === "launchd" && /<key>ProcessType<\/key>\s*<string>Background<\/string>/.test(text)) {
    out.push({
      level: "warn",
      text: "mcpd: the LaunchAgent runs as a Background process, which macOS throttles",
      fix: startFix,
    });
  }
  return out;
}

function tokenCheck(env: NodeJS.ProcessEnv): McpdCheck | undefined {
  const file = paths(env).mcpdToken;
  try {
    const st = statSync(file);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      return {
        level: "fail",
        text: `mcpd: ${tildify(file, env)} belongs to uid ${st.uid}`,
        hint: `sudo chown "$(id -un)" ${tildify(file, env)}`,
      };
    if (st.mode & 0o077) {
      return {
        level: "warn",
        text: `mcpd: ${tildify(file, env)} is readable by others (mode ${(st.mode & 0o777).toString(8)})`,
        fix: {
          label: `chmod 600 ${tildify(file, env)}`,
          run: async () => (await import("./state.js")).readToken(env, () => {}),
        },
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function portChecks(env: NodeJS.ProcessEnv): Promise<McpdCheck[]> {
  const { answersAsMcpd, daemonFiles, loadConfigSafe, mcpdPort, readLock, readStartError, readToken } = await import(
    "./state.js"
  );
  const { describeOwner, portOwner } = await import("./peerpid.js");
  const out: McpdCheck[] = [];
  const port = mcpdPort(env);
  const token = readToken(env, () => {});
  if (!token) {
    out.push({
      level: "info",
      text: `mcpd: no token at ${tildify(paths(env).mcpdToken, env)}, so it has not started yet`,
      hint: "turno mcp daemon start",
    });
    return out;
  }
  const ours = await answersAsMcpd(port, token);
  const owner = await portOwner(port, { env, ...(ours?.pid !== undefined ? { pid: ours.pid } : {}) });
  const uid = process.getuid?.();
  if (ours) {
    if (owner?.uid !== undefined && uid !== undefined && owner.uid !== uid) {
      out.push({
        level: "fail",
        text: `mcpd: port ${port} answers with your token but belongs to uid ${owner.uid}`,
        hint: "turno mcp token rotate",
      });
    } else if (owner?.pid !== undefined && ours.pid !== undefined && owner.pid !== ours.pid) {
      out.push({
        level: "warn",
        text: `mcpd: port ${port} is held by pid ${owner.pid}, but mcpd reports pid ${ours.pid}`,
        hint: "turno mcp daemon restart",
      });
    } else out.push({ level: "ok", text: `mcpd: reachable on port ${port}${ours.pid ? ` (pid ${ours.pid})` : ""}` });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      const s = (await res.json()) as {
        manifest?: { source: string; error: string | null };
        config?: { error: string | null };
      };
      if (s.manifest?.error) {
        out.push({
          level: "warn",
          text: `mcpd: mcp.toml is invalid, serving the ${s.manifest.source}: ${s.manifest.error}`,
          manual: `correct ${tildify(paths(env).mcpFile, env)} where the error points, then turno mcp daemon restart`,
        });
      }
      if (s.config?.error)
        out.push({
          level: "warn",
          text: `mcpd: config.toml is invalid, mcpd uses defaults: ${s.config.error}`,
          hint: "turno config edit",
        });
    } catch {
      /* answered a moment ago; nothing more to add */
    }
    return out;
  }
  const configured = loadConfigSafe(env).config.mcpd.port;
  if (owner) {
    out.push({
      level: "fail",
      text: `mcpd: port ${port} is in use by ${describeOwner(owner)}, so mcpd cannot listen there`,
      manual: "stop that process, or move mcpd: turno config set mcpd.port <port>, then turno mcp sync",
    });
  } else out.push({ level: "info", text: `mcpd: not reachable on port ${port}`, hint: "turno mcp daemon start" });
  if (configured !== port)
    out.push({ level: "info", text: `mcpd: config.toml says port ${configured}, the last mcpd used ${port}` });
  const e = readStartError(env);
  if (e)
    out.push({
      level: "warn",
      text: `mcpd: last start failed at ${e.at}: ${e.message}`,
      hint: "turno mcp daemon start",
    });
  const lock = readLock(env);
  if (lock)
    out.push({
      level: "info",
      text: `mcpd: stale lock from pid ${lock.pid} in ${tildify(daemonFiles(env).lock, env)} (the next start clears it)`,
    });
  return out;
}

async function syncedPortCheck(env: NodeJS.ProcessEnv): Promise<McpdCheck | undefined> {
  const { peekManaged } = await import("./sync.js");
  const { mcpdPort } = await import("./state.js");
  const port = mcpdPort(env);
  const off: string[] = [];
  const seen = new Set<number>();
  for (const file of Object.keys(peekManaged(paths(env).mcpdManaged))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const ports = syncedPorts(text).filter((p) => p !== port);
    if (ports.length) {
      off.push(tildify(file, env));
      for (const p of ports) seen.add(p);
    }
  }
  if (!off.length) return undefined;
  return {
    level: "warn",
    text: `mcpd: ${off.length} synced config${off.length === 1 ? "" : "s"} point at port ${[...seen].join(", ")} but mcpd uses ${port} (${off.join(", ")})`,
    fix: syncFix,
  };
}

const PROFILE_BEARER = /Bearer (tp1\.[a-z0-9][a-z0-9_-]*\.[A-Za-z0-9_-]{43})/g;

/**
 * The agent config files `turno mcp sync` writes: those mcp-managed.json lists, and every
 * profile's config and the hub's, so a sync from before that file existed (or a lost one)
 * is still checked.
 */
function syncedFiles(env: NodeJS.ProcessEnv): string[] {
  const files = new Set<string>();
  // No mcp-managed.json, or one that cannot be used: the profiles' configs are still checked.
  for (const f of Object.keys(readState(paths(env).mcpdManaged, isRecord) ?? {})) files.add(f);
  try {
    const config = loadConfig(env);
    for (const name of listProfiles(config, env)) files.add(mcpFileFor(name, agentOf(name, config), env));
  } catch {
    /* a broken config.toml is reported elsewhere */
  }
  files.add(adapter(DEFAULT_AGENT).mcp.hubFile(env));
  return [...files];
}

/**
 * Synced configs and launcher token files that mcpd would refuse: configs written
 * before per-profile tokens still carry the master token, and every derived token dies with a
 * `turno mcp token rotate`. Both are fixed by `turno mcp sync`. Works without mcp-managed.json.
 * Never prints a token.
 */
export function tokenSyncCheck(env: NodeJS.ProcessEnv): McpdCheck | undefined {
  const p = paths(env);
  let master: string;
  try {
    master = readFileSync(p.mcpdToken, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!master) return undefined;
  const legacy: string[] = [];
  const stale: string[] = [];
  for (const file of syncedFiles(env)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes(master)) legacy.push(tildify(file, env));
    else if ([...text.matchAll(PROFILE_BEARER)].some((m) => !tokenProfile(master, m[1]!)))
      stale.push(tildify(file, env));
  }
  const dir = dirname(profileTokenFile("x", env));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".token"));
  } catch {
    /* no token files */
  }
  for (const f of names) {
    const profile = f.slice(0, -".token".length);
    try {
      if (tokenProfile(master, readFileSync(join(dir, f), "utf8").trim()) !== profile)
        stale.push(tildify(join(dir, f), env));
    } catch {
      /* unreadable: the launcher sends nothing and mcpd says why */
    }
  }
  const s = (n: number) => (n === 1 ? "" : "s");
  if (legacy.length) {
    return {
      level: "warn",
      text: `mcpd: ${legacy.length} synced config${s(legacy.length)} still send${legacy.length === 1 ? "s" : ""} the master token, which mcpd no longer accepts for MCP sessions (${legacy.join(", ")})`,
      fix: syncFix,
    };
  }
  if (stale.length) {
    return {
      level: "warn",
      text: `mcpd: ${stale.length} profile token${s(stale.length)} predate${stale.length === 1 ? "s" : ""} the current gateway token (${stale.join(", ")})`,
      fix: syncFix,
    };
  }
  return undefined;
}

export async function mcpdChecks(env: NodeJS.ProcessEnv): Promise<McpdCheck[]> {
  const out: McpdCheck[] = [];
  try {
    out.push(...(await serviceChecks(env)));
  } catch (err) {
    out.push({
      level: "warn",
      text: `mcpd: cannot read the service file: ${(err as Error).message}`,
      hint: "turno mcp daemon start",
    });
  }
  const t = tokenCheck(env);
  if (t) out.push(t);
  out.push(...(await portChecks(env)));
  const s = await syncedPortCheck(env);
  if (s) out.push(s);
  const tk = tokenSyncCheck(env);
  if (tk) out.push(tk);
  return out;
}
