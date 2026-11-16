import { existsSync, readFileSync, statSync } from "node:fs";
import type { Io } from "../cli/io.js";
import { paths, tildify } from "../core/paths.js";

/**
 * The mcpd part of `turno doctor` (ADR 0017): the service file and the paths it runs, the
 * token's mode, who answers on the port, why mcpd is down, the manifest it serves, and
 * whether synced profiles point at the port mcpd uses.
 */
export interface McpdCheck {
  level: "ok" | "warn" | "fail" | "info";
  text: string;
  fix?: { label: string; run(io: Io): Promise<unknown> | unknown };
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
  else if (missing.length) out.push({ level: "fail", text: `mcpd: ${shown} runs ${missing.map((m) => tildify(m, env)).join(", ")}, which no longer exists`, fix: startFix });
  else if (program.some((a) => a.startsWith("/") && isUnstablePath(a))) {
    out.push({ level: "warn", text: `mcpd: ${shown} runs a versioned path (${tildify(program[0]!, env)}) that breaks when that version is removed`, fix: startFix });
  } else out.push({ level: "ok", text: `mcpd: ${backend.noun} ${shown}` });
  if (backend.kind === "launchd" && /<key>ProcessType<\/key>\s*<string>Background<\/string>/.test(text)) {
    out.push({ level: "warn", text: "mcpd: the LaunchAgent runs as a Background process, which macOS throttles", fix: startFix });
  }
  return out;
}

function tokenCheck(env: NodeJS.ProcessEnv): McpdCheck | undefined {
  const file = paths(env).mcpdToken;
  try {
    const st = statSync(file);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return { level: "fail", text: `mcpd: ${tildify(file, env)} belongs to uid ${st.uid}` };
    if (st.mode & 0o077) {
      return {
        level: "warn",
        text: `mcpd: ${tildify(file, env)} is readable by others (mode ${(st.mode & 0o777).toString(8)})`,
        fix: { label: `chmod 600 ${tildify(file, env)}`, run: async () => (await import("./daemon.js")).readToken(env, () => {}) },
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function portChecks(env: NodeJS.ProcessEnv): Promise<McpdCheck[]> {
  const { answersAsMcpd, daemonFiles, loadConfigSafe, mcpdPort, readLock, readStartError, readToken } = await import("./daemon.js");
  const { describeOwner, portOwner } = await import("./peerpid.js");
  const out: McpdCheck[] = [];
  const port = mcpdPort(env);
  const token = readToken(env, () => {});
  if (!token) {
    out.push({ level: "info", text: `mcpd: no token at ${tildify(paths(env).mcpdToken, env)} (not started yet: turno mcp daemon start)` });
    return out;
  }
  const ours = await answersAsMcpd(port, token);
  const owner = await portOwner(port, { env });
  const uid = process.getuid?.();
  if (ours) {
    if (owner?.uid !== undefined && uid !== undefined && owner.uid !== uid) {
      out.push({ level: "fail", text: `mcpd: port ${port} answers with your token but belongs to uid ${owner.uid}; rotate it: turno mcp token rotate` });
    } else if (owner?.pid !== undefined && ours.pid !== undefined && owner.pid !== ours.pid) {
      out.push({ level: "warn", text: `mcpd: port ${port} is held by pid ${owner.pid}, but mcpd reports pid ${ours.pid}` });
    } else out.push({ level: "ok", text: `mcpd: reachable on port ${port}${ours.pid ? ` (pid ${ours.pid})` : ""}` });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      const s = (await res.json()) as { manifest?: { source: string; error: string | null }; config?: { error: string | null } };
      if (s.manifest?.error) out.push({ level: "warn", text: `mcpd: mcp.toml is invalid, serving the ${s.manifest.source}: ${s.manifest.error}` });
      if (s.config?.error) out.push({ level: "warn", text: `mcpd: config.toml is invalid, mcpd uses defaults: ${s.config.error}` });
    } catch {
      /* answered a moment ago; nothing more to add */
    }
    return out;
  }
  const configured = loadConfigSafe(env).config.mcpd.port;
  if (owner) {
    out.push({ level: "fail", text: `mcpd: port ${port} is in use by ${describeOwner(owner)}, so mcpd cannot listen there (free it, or turno config set mcpd.port <port> and turno mcp sync)` });
  } else out.push({ level: "info", text: `mcpd: not reachable on port ${port} (turno mcp daemon start)` });
  if (configured !== port) out.push({ level: "info", text: `mcpd: config.toml says port ${configured}, the last mcpd used ${port}` });
  const e = readStartError(env);
  if (e) out.push({ level: "warn", text: `mcpd: last start failed at ${e.at}: ${e.message}` });
  const lock = readLock(env);
  if (lock) out.push({ level: "info", text: `mcpd: stale lock from pid ${lock.pid} in ${tildify(daemonFiles(env).lock, env)} (the next start clears it)` });
  return out;
}

async function syncedPortCheck(env: NodeJS.ProcessEnv): Promise<McpdCheck | undefined> {
  const { readManaged } = await import("./sync.js");
  const { mcpdPort } = await import("./daemon.js");
  const port = mcpdPort(env);
  const off: string[] = [];
  const seen = new Set<number>();
  for (const file of Object.keys(readManaged(paths(env).mcpdManaged))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const ports = syncedPorts(text).filter((p) => p !== port);
    if (ports.length) {
      off.push(tildify(file, env));
      ports.forEach((p) => seen.add(p));
    }
  }
  if (!off.length) return undefined;
  return {
    level: "warn",
    text: `mcpd: ${off.length} synced config${off.length === 1 ? "" : "s"} point at port ${[...seen].join(", ")} but mcpd uses ${port} (${off.join(", ")})`,
    fix: syncFix,
  };
}

export async function mcpdChecks(env: NodeJS.ProcessEnv): Promise<McpdCheck[]> {
  const out: McpdCheck[] = [];
  try {
    out.push(...(await serviceChecks(env)));
  } catch (err) {
    out.push({ level: "warn", text: `mcpd: cannot read the service file: ${(err as Error).message}` });
  }
  const t = tokenCheck(env);
  if (t) out.push(t);
  out.push(...(await portChecks(env)));
  const s = await syncedPortCheck(env);
  if (s) out.push(s);
  return out;
}
