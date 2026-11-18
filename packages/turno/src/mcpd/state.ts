/**
 * The gateway's files in the state folder (token, lock, port, last start error) and the
 * config it would use, without loading the gateway itself. `turno status`, `doctor` and the
 * `mcp` commands read these on every run, so this module stays free of the MCP SDK; daemon.ts
 * re-exports all of it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Config, loadConfig, parseConfig } from "../core/config.js";
import { pidAlive } from "../core/fsutil.js";
import { atomicWrite } from "../core/journal.js";
import { paths } from "../core/paths.js";
import { hasFields, readState } from "../core/state-file.js";

/** Files mcpd keeps in the state folder besides `mcpd.token` and `mcpd.port`. */
export function daemonFiles(env: NodeJS.ProcessEnv = process.env): { lock: string; lastGood: string; error: string; log: string; calls: string; rss: string } {
  const p = paths(env);
  return {
    lock: join(p.state, "mcpd.lock"),
    lastGood: join(p.state, "mcp.last-good.toml"),
    error: join(p.state, "mcpd.error.json"),
    log: join(p.logsDir, "mcpd.log"),
    calls: join(p.logsDir, "calls.jsonl"),
    rss: join(p.state, "mcpd-rss.json"),
  };
}

// ---------------------------------------------------------------------------------------------
// Token

export type TokenMode = "read" | "ensure" | "rotate";

function defaultWarn(message: string): void {
  process.stderr.write(`turno: ${message}\n`);
}

/**
 * The only place that reads or writes the gateway's master token (mode 600, in the state
 * folder). `read` returns it or undefined; `ensure` creates it when missing; `rotate` always
 * writes a new one. On read the file is checked with fstat: a mode wider than 600 is fixed (or
 * reported when it cannot be), and a file owned by another user is reported. The token is
 * never printed. Per-profile tokens derive from this one (mcpd/tokens.ts, ADR 0023).
 */
export function masterToken(env: NodeJS.ProcessEnv = process.env, mode: TokenMode = "ensure", warn: (message: string) => void = defaultWarn): string | undefined {
  const file = paths(env).mcpdToken;
  if (mode !== "rotate") {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (st.isFile()) {
        const uid = process.getuid?.();
        if (uid !== undefined && st.uid !== uid) warn(`${file} belongs to uid ${st.uid}, not to you; rotate it with: turno mcp token rotate`);
        else if (st.mode & 0o077) {
          try {
            fchmodSync(fd, 0o600);
            warn(`${file} was readable by others (mode ${(st.mode & 0o777).toString(8)}); set it to 600`);
          } catch {
            warn(`${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
          }
        }
        const t = readFileSync(fd, "utf8").trim();
        if (t.length >= 32) return t;
      } else warn(`${file} is not a regular file`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP") warn(`${file} is a symbolic link; turno replaces it with a regular file`);
      else if (code !== "ENOENT") warn(`cannot read ${file}: ${(err as Error).message}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (mode === "read") return undefined;
  }
  const token = randomBytes(32).toString("hex");
  atomicWrite(file, `${token}\n`, 0o600);
  return token;
}

/** The bearer token sessions use; created once with mode 600. */
export function ensureToken(env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): string {
  return masterToken(env, "ensure", warn) as string;
}

export function readToken(env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): string | undefined {
  return masterToken(env, "read", warn);
}

/** Replace the token with a new one. Profiles need `turno mcp sync` and mcpd a restart (or SIGHUP). */
export function rotateToken(env: NodeJS.ProcessEnv = process.env): string {
  return masterToken(env, "rotate") as string;
}

// ---------------------------------------------------------------------------------------------
// Lock and port

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

const isLockInfo = (v: unknown): v is LockInfo => hasFields(v, { pid: "number" }) && Number.isInteger(v.pid) && (v.pid as number) > 0;

/** The lock file, or undefined when there is none or it is not a lock (state-file.ts). */
export function readLock(env: NodeJS.ProcessEnv = process.env): LockInfo | undefined {
  return readState(daemonFiles(env).lock, isLockInfo);
}

/** Whether `pid` runs mcpd: alive and, when ps can tell, its command line is `... mcp daemon run` (or `mcpd run`). */
export function isMcpdProcess(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!pidAlive(pid)) return false;
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return /\b(mcpd|daemon) run\b/.test(cmd);
  } catch {
    return true; // cannot tell: assume it is
  }
}

/** The lock of a live mcpd, or undefined (no lock, or a stale one left by a crash). */
export function liveLock(env: NodeJS.ProcessEnv = process.env): LockInfo | undefined {
  const lock = readLock(env);
  return lock && isMcpdProcess(lock.pid) ? lock : undefined;
}

/** Configuration that never throws: a broken config.toml gives the defaults, keeping its port when it can be read. */
export function loadConfigSafe(env: NodeJS.ProcessEnv = process.env): { config: Config; error?: string } {
  try {
    return { config: loadConfig(env) };
  } catch (err) {
    const file = paths(env).configFile;
    const config = parseConfig("", file, env);
    try {
      const port = ((parseToml(readFileSync(file, "utf8")) as Record<string, unknown>).mcpd as Record<string, unknown> | undefined)?.port;
      if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535) config.mcpd.port = port;
    } catch {
      /* not even TOML: the default port */
    }
    return { config, error: (err as Error).message };
  }
}

/**
 * The port mcpd listens on: the one a live mcpd recorded, else the configured one. A port
 * file without a live lock is stale (a crash) and ignored; one without any lock comes from an
 * mcpd older than the lock and is trusted.
 */
export function mcpdPort(env: NodeJS.ProcessEnv = process.env): number {
  const lock = readLock(env);
  if (!lock || pidAlive(lock.pid)) {
    try {
      const n = Number.parseInt(readFileSync(paths(env).mcpdPort, "utf8"), 10);
      if (n > 0) return n;
    } catch {
      /* fall through */
    }
  }
  return loadConfigSafe(env).config.mcpd.port;
}

/** The last reason mcpd could not start, for `status` and `doctor`. Cleared by a good start. */
export interface StartError {
  at: string;
  message: string;
  port?: number;
}

const isStartError = (v: unknown): v is StartError => hasFields(v, { at: "string", message: "string" });

export function readStartError(env: NodeJS.ProcessEnv = process.env): StartError | undefined {
  return readState(daemonFiles(env).error, isStartError);
}

/** Whether our own mcpd answers /status on `port` with our token. */
export async function answersAsMcpd(port: number, token: string | undefined): Promise<{ pid?: number } | undefined> {
  if (!token) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pid?: number };
    return { ...(typeof body.pid === "number" ? { pid: body.pid } : {}) };
  } catch {
    return undefined;
  }
}
