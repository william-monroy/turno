import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  type WriteStream,
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Config, loadConfig, parseConfig } from "../core/config.js";
import { atomicWrite } from "../core/journal.js";
import { type Manifest, parseManifest } from "../core/manifest.js";
import { PRIVATE_FILE_MODE, ensurePrivateDir, paths } from "../core/paths.js";
import { keychainResolver } from "../core/secrets.js";
import { packageInfo } from "../core/version.js";
import { DescriptionCache } from "./cache.js";
import { createCallLog } from "./calllog.js";
import { type BuiltinFactory, DefaultConnector } from "./connectors.js";
import { Gateway, type GatewayOptions } from "./gateway.js";
import { InstanceManager, descriptionFingerprint, processAlive } from "./instances.js";
import { describeOwner, peerPid, portOwner } from "./peerpid.js";
import { memoryPressureProbe } from "./pressure.js";
import { RssSampler } from "./rss.js";

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

export function readLock(env: NodeJS.ProcessEnv = process.env): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(daemonFiles(env).lock, "utf8")) as LockInfo;
    return Number.isInteger(v.pid) && v.pid > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

/** Another mcpd already holds the lock or answers on the port. Not a failure for a supervisor. */
export class AlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyRunningError";
  }
}

/** The configured port belongs to some other process. */
export class PortBusyError extends Error {
  constructor(
    message: string,
    readonly port: number,
  ) {
    super(message);
    this.name = "PortBusyError";
  }
}

/** Take the single-instance lock (O_EXCL), clearing a stale one once. */
function acquireLock(env: NodeJS.ProcessEnv): void {
  const file = daemonFiles(env).lock;
  ensurePrivateDir(dirname(file), env);
  const body = JSON.stringify({ pid: process.pid, port: 0, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${body}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // removed meanwhile: try again
    }
    const held = readLock(env);
    if (held && isMcpdProcess(held.pid)) {
      throw new AlreadyRunningError(`mcpd is already running (pid ${held.pid}${held.port ? `, port ${held.port}` : ""}); stop it with: turno mcp daemon stop`);
    }
    // Stale: remove it only if nobody replaced it since we read it.
    try {
      if (readFileSync(file, "utf8") === text) rmSync(file, { force: true });
    } catch {
      /* gone already */
    }
  }
  throw new AlreadyRunningError("another mcpd is starting right now");
}

function releaseLock(env: NodeJS.ProcessEnv, port: number): void {
  const f = daemonFiles(env);
  if (readLock(env)?.pid !== process.pid) return;
  rmSync(f.lock, { force: true });
  try {
    if (Number.parseInt(readFileSync(paths(env).mcpdPort, "utf8"), 10) === port) rmSync(paths(env).mcpdPort, { force: true });
  } catch {
    /* no port file */
  }
}

/** The last reason mcpd could not start, for `status` and `doctor`. Cleared by a good start. */
export interface StartError {
  at: string;
  message: string;
  port?: number;
}

export function readStartError(env: NodeJS.ProcessEnv = process.env): StartError | undefined {
  try {
    return JSON.parse(readFileSync(daemonFiles(env).error, "utf8")) as StartError;
  } catch {
    return undefined;
  }
}

function writeStartError(env: NodeJS.ProcessEnv, e: StartError | undefined): void {
  const file = daemonFiles(env).error;
  try {
    if (!e) rmSync(file, { force: true });
    else {
      ensurePrivateDir(dirname(file), env);
      atomicWrite(file, `${JSON.stringify(e)}\n`, PRIVATE_FILE_MODE);
    }
  } catch {
    /* best effort */
  }
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

// ---------------------------------------------------------------------------------------------
// Log

export interface Logger {
  (line: string): void;
  close(): Promise<void>;
}

/**
 * The mcpd log: one append stream, rotated by size (mcpd.log.1 ... mcpd.log.<keep>), with an
 * error handler so a full disk never takes the daemon down. Timestamps are UTC ISO;
 * `turno mcp daemon logs` shows them in local time.
 */
export function createLogger(file: string, opts: { maxBytes?: number; keep?: number; toStdout?: boolean; env?: NodeJS.ProcessEnv } = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 2;
  let stream: WriteStream | undefined;
  let size = 0;
  let broken = false;
  const onError = (err: Error) => {
    if (broken) return;
    broken = true;
    try {
      process.stderr.write(`mcpd: cannot write ${file}: ${err.message}\n`);
    } catch {
      /* nowhere to report */
    }
  };
  let retryAt = 0;
  // Opened synchronously so the file exists before the first rotation renames it.
  const open = (): WriteStream | undefined => {
    try {
      ensurePrivateDir(dirname(file), opts.env);
      const fd = openSync(file, "a", PRIVATE_FILE_MODE);
      const st = fstatSync(fd);
      if (st.mode & 0o077) fchmodSync(fd, PRIVATE_FILE_MODE);
      size = st.size;
      const s = createWriteStream("", { fd });
      s.on("error", onError);
      broken = false;
      return s;
    } catch (err) {
      onError(err as Error);
      retryAt = Date.now() + 30_000;
      return undefined;
    }
  };
  const rotate = () => {
    stream?.end();
    try {
      for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    } catch (err) {
      onError(err as Error);
    }
    stream = open();
  };
  const log = ((line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    if (opts.toStdout) {
      process.stdout.write(text);
      return;
    }
    if (!stream && Date.now() >= retryAt) stream = open();
    if (!stream) return; // the disk refused; onError said so once
    const n = Buffer.byteLength(text);
    if (size > 0 && size + n > maxBytes) rotate();
    stream?.write(text);
    size += n;
  }) as Logger;
  log.close = () => new Promise<void>((resolve) => (stream ? stream.end(() => resolve()) : resolve()));
  return log;
}

/** Errors a socket or the disk raises that do not leave the daemon in a bad state. */
const RECOVERABLE = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOSPC", "EIO", "EAGAIN", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PREMATURE_CLOSE"]);

/**
 * For the daemon process only (not for tests that start mcpd in process): log unhandled
 * rejections and recoverable exceptions and keep serving; on anything else log it, stop
 * cleanly and exit 1 so the service manager restarts mcpd.
 */
export function installCrashGuards(log: (line: string) => void, stop: () => Promise<void>): () => void {
  const onRejection = (reason: unknown) => log(`unhandled rejection, still running: ${(reason as Error)?.stack ?? String(reason)}`);
  const onException = (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && RECOVERABLE.has(code)) {
      log(`uncaught ${code}, still running: ${err.stack ?? err.message}`);
      return;
    }
    log(`fatal: ${err.stack ?? err.message}`);
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      process.exit(1);
    };
    const timer = setTimeout(exit, 3000);
    timer.unref();
    stop().then(exit, exit);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}

// ---------------------------------------------------------------------------------------------
// Manifest

export type ManifestSource = "mcp.toml" | "last good copy" | "empty";

export interface ManifestState {
  manifest: Manifest;
  source: ManifestSource;
  /** Why mcp.toml was not used. */
  error?: string;
}

/**
 * mcp.toml, never throwing: when it does not validate, the last copy that did (kept in the
 * state folder on every good load), else no servers. The error is kept for /status and doctor.
 */
export function loadManifestSafe(env: NodeJS.ProcessEnv = process.env): ManifestState {
  const file = paths(env).mcpFile;
  const lastGood = daemonFiles(env).lastGood;
  try {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const manifest = parseManifest(text, file);
    if (text) {
      try {
        if (!existsSync(lastGood) || readFileSync(lastGood, "utf8") !== text) atomicWrite(lastGood, text, 0o600);
      } catch {
        /* the copy is a convenience */
      }
    }
    return { manifest, source: "mcp.toml" };
  } catch (err) {
    const error = (err as Error).message;
    try {
      return { manifest: parseManifest(readFileSync(lastGood, "utf8"), lastGood), source: "last good copy", error };
    } catch {
      return { manifest: parseManifest(""), source: "empty", error };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Daemon

async function loadBuiltins(): Promise<Record<string, BuiltinFactory>> {
  const builtins: Record<string, BuiltinFactory> = {};
  try {
    const mod = (await import("../accounts/builtin.js")) as { accountsBuiltin?: () => BuiltinFactory };
    if (mod.accountsBuiltin) builtins.accounts = mod.accountsBuiltin();
  } catch {
    // accounts bridge not available in this build
  }
  return builtins;
}

/** The gateway plus what only the daemon knows (port, manifest state), in /status. */
class DaemonGateway extends Gateway {
  constructor(
    opts: GatewayOptions,
    private readonly extra: () => Record<string, unknown>,
  ) {
    super(opts);
  }

  override status(): unknown {
    return { ...(super.status() as Record<string, unknown>), ...this.extra() };
  }
}

export interface RunningDaemon {
  port: number;
  gateway: Gateway;
  manager: InstanceManager;
  log: (line: string) => void;
  stop(): Promise<void>;
}

/**
 * Start mcpd in this process (`turno mcp daemon run`, in a terminal or under the service).
 * Single instance: a lock file with the PID, and no port fallback. If the configured port is
 * busy it fails with PortBusyError naming the owner, because every synced profile points at
 * that port. A broken mcp.toml or config.toml never stops it from starting.
 */
export async function startDaemon(opts: { env?: NodeJS.ProcessEnv; port?: number; logToStdout?: boolean; logMaxBytes?: number } = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const p = paths(env);
  const files = daemonFiles(env);
  const log = createLogger(files.log, { env, toStdout: Boolean(opts.logToStdout), ...(opts.logMaxBytes ? { maxBytes: opts.logMaxBytes } : {}) });

  const { config, error: firstConfigError } = loadConfigSafe(env);
  let configError = firstConfigError;
  if (configError) log(`config.toml is invalid, using defaults: ${configError}`);
  // Folder server sets (ADR 0031): the last good [[projects]] rules, reloaded with config.toml.
  let folderRules = config.projects;
  const wanted = opts.port ?? config.mcpd.port;
  const fail = async (err: Error): Promise<never> => {
    if (!(err instanceof AlreadyRunningError)) writeStartError(env, { at: new Date().toISOString(), message: err.message, port: wanted });
    log(`mcpd could not start: ${err.message}`);
    await log.close();
    throw err;
  };

  try {
    acquireLock(env);
  } catch (err) {
    return fail(err as Error);
  }

  let state = loadManifestSafe(env);
  if (state.error) log(`mcp.toml is invalid, serving the ${state.source}: ${state.error}`);
  const startedAt = new Date().toISOString();
  let port = 0;
  try {
    const token = ensureToken(env, (m) => log(m));
    const calls = config.mcpd.callLog ? createCallLog(files.calls, { onError: (m) => log(m) }) : undefined;
    const sampler = new RssSampler(files.rss, { env });
    const manager = new InstanceManager({
      cache: new DescriptionCache(p.mcpdCacheDir),
      connector: new DefaultConnector({
        resolve: keychainResolver(env),
        serversDir: p.serversDir,
        logsDir: p.logsDir,
        vars: env,
        builtins: await loadBuiltins(),
        baseEnv: Object.fromEntries(
          ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"].flatMap((k) => (env[k] ? [[k, env[k] as string]] : [])),
        ),
      }),
      home: p.home,
      log,
      ...(calls ? { onCall: (e) => calls.record(e) } : {}),
      pressure: memoryPressureProbe(),
      idleUnderPressure: config.mcpd.idleUnderPressure,
    });
    const gwOpts: GatewayOptions = {
      manager,
      manifest: () => state.manifest,
      token,
      peerPid: (rp) => peerPid(rp),
      log,
      folderRules: () => folderRules,
      home: p.home,
      ...(config.mcpd.maxRequestBody ? { maxRequestBodyBytes: config.mcpd.maxRequestBody } : {}),
    };
    const gateway = new DaemonGateway(gwOpts, () => ({
      version: packageInfo().version,
      port,
      startedAt,
      manifest: { source: state.source, servers: Object.keys(state.manifest.servers).length, error: state.error ?? null },
      config: { error: configError ?? null, folderSets: folderRules.filter((r) => r.mcp || r.mcpDeny).length },
      callLog: { enabled: Boolean(calls) },
      serverRss: sampler.samples(),
    }));

    try {
      port = await gateway.listen(wanted);
    } catch (err) {
      await gateway.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      const ours = await answersAsMcpd(wanted, token);
      if (ours) throw new AlreadyRunningError(`mcpd is already running on port ${wanted}${ours.pid ? ` (pid ${ours.pid})` : ""}`);
      const owner = await portOwner(wanted, { env });
      throw new PortBusyError(
        `port ${wanted} is in use by ${describeOwner(owner)}. mcpd does not move to another port, because every synced profile points at this one: free the port, or pick another with \`turno config set mcpd.port <port>\` and run \`turno mcp sync\``,
        wanted,
      );
    }
    writeFileSync(files.lock, `${JSON.stringify({ pid: process.pid, port, startedAt })}\n`, { mode: PRIVATE_FILE_MODE });
    ensurePrivateDir(dirname(p.mcpdPort), env);
    atomicWrite(p.mcpdPort, `${port}\n`, PRIVATE_FILE_MODE);
    writeStartError(env, undefined);
    log(`mcpd ${packageInfo().version} listening on 127.0.0.1:${port} with ${Object.keys(state.manifest.servers).length} servers`);

    const reload = async (why: string) => {
      const next = loadManifestSafe(env);
      if (next.error) {
        // Keep serving what runs now; remember why the file was refused.
        state = { ...state, error: next.error, source: state.source === "mcp.toml" ? "last good copy" : state.source };
        log(`reload skipped (${why}): ${next.error}`);
        return;
      }
      // Stop instances whose definition changed or disappeared; the next call starts the new one.
      for (const inst of manager.list()) {
        const def = next.manifest.servers[inst.server.name];
        if (!def || descriptionFingerprint(def, inst.variant) !== descriptionFingerprint(inst.server, inst.variant)) {
          await manager.stop(inst.key);
          log(`stopped ${inst.upstream.label} after manifest change`);
        }
      }
      state = next;
      log(`manifest reloaded (${why}): ${Object.keys(state.manifest.servers).length} servers`);
    };

    /** config.toml: a broken file keeps the last good settings and is reported in /status. */
    const reloadConfig = (why: string) => {
      let next: Config;
      try {
        next = loadConfig(env);
      } catch (err) {
        configError = (err as Error).message;
        log(`config.toml reload skipped (${why}): ${configError}`);
        return;
      }
      configError = undefined;
      folderRules = next.projects;
      log(`config.toml reloaded (${why}): ${folderRules.filter((r) => r.mcp || r.mcpDeny).length} folder server sets`);
    };

    let debounce: NodeJS.Timeout | undefined;
    let configDebounce: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    if (existsSync(p.config)) {
      try {
        watcher = watch(p.config, (_event, file) => {
          if (file === "config.toml") {
            clearTimeout(configDebounce);
            configDebounce = setTimeout(() => reloadConfig("config.toml changed"), 300);
            return;
          }
          if (file !== "mcp.toml") return;
          clearTimeout(debounce);
          debounce = setTimeout(() => void reload("mcp.toml changed").catch((e) => log(`reload failed: ${(e as Error).message}`)), 300);
        });
        watcher.on("error", (e) => log(`config watch failed: ${e.message}`));
      } catch (e) {
        log(`config watch failed: ${(e as Error).message}`);
      }
    }
    // SIGHUP reloads the manifest, config.toml and the token (after `turno mcp token rotate`).
    const onHup = () => {
      reloadConfig("SIGHUP");
      const t = readToken(env, (m) => log(m));
      if (t && t !== gwOpts.token) {
        gwOpts.token = t;
        log("token reloaded");
      }
      void reload("SIGHUP").catch((e) => log(`reload failed: ${(e as Error).message}`));
    };
    process.on("SIGHUP", onHup);

    const timer = setInterval(() => {
      gateway.pruneSessions(processAlive);
      manager
        .reap()
        .then((stopped) => stopped.forEach((s) => log(`reaped ${s}`)))
        .catch((err) => log(`reap failed: ${(err as Error).message}`));
      void sampler.sample(manager.list().map((i) => ({ descKey: i.descKey, pid: i.upstream.pid })));
    }, 15_000);
    timer.unref();

    let stopped = false;
    return {
      port,
      gateway,
      manager,
      log,
      async stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        clearTimeout(debounce);
        clearTimeout(configDebounce);
        watcher?.close();
        process.off("SIGHUP", onHup);
        await manager.stopAll();
        await gateway.close();
        releaseLock(env, port);
        calls?.close();
        log("mcpd stopped");
        await log.close();
      },
    };
  } catch (err) {
    releaseLock(env, port);
    return fail(err as Error);
  }
}
