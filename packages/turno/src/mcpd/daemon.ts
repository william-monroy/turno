import {
  type WriteStream,
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
import { type Config, loadConfig } from "../core/config.js";
import { atomicWrite } from "../core/journal.js";
import { type Manifest, parseManifest } from "../core/manifest.js";
import { PRIVATE_FILE_MODE, ensurePrivateDir, paths } from "../core/paths.js";
import { keychainResolver } from "../core/secrets.js";
import { packageInfo } from "../core/version.js";
import { DescriptionCache } from "./cache.js";
import { createCallLog } from "./calllog.js";
import { type BuiltinFactory, DefaultConnector } from "./connectors.js";
import { Gateway, type GatewayOptions } from "./gateway.js";
import { ClientNames } from "./client-names.js";
import { InstanceManager, descriptionFingerprint } from "./instances.js";
import { describeOwner, peerPid, portOwner } from "./peerpid.js";
import { memoryPressureProbe } from "./pressure.js";
import { RssSampler } from "./rss.js";
import { pidAlive } from "../core/fsutil.js";
import {
  type StartError,
  answersAsMcpd,
  daemonFiles,
  ensureToken,
  isMcpdProcess,
  loadConfigSafe,
  readLock,
  readToken,
} from "./state.js";

export { daemonFiles, loadConfigSafe, masterToken, mcpdPort, readStartError, readToken, rotateToken } from "./state.js";

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
      throw new AlreadyRunningError(
        `mcpd is already running (pid ${held.pid}${held.port ? `, port ${held.port}` : ""}); stop it with: turno mcp daemon stop`,
      );
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
    if (Number.parseInt(readFileSync(paths(env).mcpdPort, "utf8"), 10) === port)
      rmSync(paths(env).mcpdPort, { force: true });
  } catch {
    /* no port file */
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
export function createLogger(
  file: string,
  opts: { maxBytes?: number; keep?: number; toStdout?: boolean; env?: NodeJS.ProcessEnv } = {},
): Logger {
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
      ensurePrivateDir(dirname(file), opts.env ?? process.env);
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
      for (let i = keep - 1; i >= 1; i--)
        if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
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
const RECOVERABLE = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOSPC",
  "EIO",
  "EAGAIN",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * For the daemon process only (not for tests that start mcpd in process): log unhandled
 * rejections and recoverable exceptions and keep serving; on anything else log it, stop
 * cleanly and exit 1 so the service manager restarts mcpd.
 */
export function installCrashGuards(log: (line: string) => void, stop: () => Promise<void>): () => void {
  const onRejection = (reason: unknown) =>
    log(`unhandled rejection, still running: ${(reason as Error)?.stack ?? String(reason)}`);
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

type ManifestSource = "mcp.toml" | "last good copy" | "empty";

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
export async function startDaemon(
  opts: { env?: NodeJS.ProcessEnv; port?: number; logToStdout?: boolean; logMaxBytes?: number } = {},
): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const p = paths(env);
  const files = daemonFiles(env);
  const log = createLogger(files.log, {
    env,
    toStdout: Boolean(opts.logToStdout),
    ...(opts.logMaxBytes ? { maxBytes: opts.logMaxBytes } : {}),
  });

  const { config, error: firstConfigError } = loadConfigSafe(env);
  let configError = firstConfigError;
  if (configError) log(`config.toml is invalid, using defaults: ${configError}`);
  // Folder server sets (ADR 0031): the last good [[projects]] rules, reloaded with config.toml.
  let folderRules = config.projects;
  const wanted = opts.port ?? config.mcpd.port;
  const fail = async (err: Error): Promise<never> => {
    if (!(err instanceof AlreadyRunningError))
      writeStartError(env, { at: new Date().toISOString(), message: err.message, port: wanted });
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
    // The call log follows `[mcpd] call_log`, also when config.toml changes while mcpd runs.
    let calls = config.mcpd.callLog ? createCallLog(files.calls, { onError: (m) => log(m) }) : undefined;
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
          ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"].flatMap((k) =>
            env[k] ? [[k, env[k] as string]] : [],
          ),
        ),
      }),
      home: p.home,
      log,
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
      clientNames: new ClientNames(join(p.state, "mcpd-clients.json"), pidAlive),
      callLog: () => (calls ? (e) => calls?.record(e) : undefined),
      ...(config.mcpd.maxRequestBody ? { maxRequestBodyBytes: config.mcpd.maxRequestBody } : {}),
    };
    const gateway = new DaemonGateway(gwOpts, () => ({
      version: packageInfo().version,
      port,
      startedAt,
      manifest: {
        source: state.source,
        servers: Object.keys(state.manifest.servers).length,
        error: state.error ?? null,
      },
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
      if (ours)
        throw new AlreadyRunningError(
          `mcpd is already running on port ${wanted}${ours.pid ? ` (pid ${ours.pid})` : ""}`,
        );
      const owner = await portOwner(wanted, { env });
      throw new PortBusyError(
        `port ${wanted} is in use by ${describeOwner(owner)}. mcpd does not move to another port, because every synced profile points at this one: free the port, or pick another with \`turno config set mcpd.port <port>\` and run \`turno mcp sync\``,
        wanted,
      );
    }
    writeFileSync(files.lock, `${JSON.stringify({ pid: process.pid, port, startedAt })}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    ensurePrivateDir(dirname(p.mcpdPort), env);
    atomicWrite(p.mcpdPort, `${port}\n`, PRIVATE_FILE_MODE);
    writeStartError(env, undefined);
    log(
      `mcpd ${packageInfo().version} listening on 127.0.0.1:${port} with ${Object.keys(state.manifest.servers).length} servers`,
    );

    const reload = async (why: string) => {
      const next = loadManifestSafe(env);
      if (next.error) {
        // Keep serving what runs now; remember why the file was refused.
        state = { ...state, error: next.error, source: state.source === "mcp.toml" ? "last good copy" : state.source };
        log(`reload skipped (${why}): ${next.error}`);
        return;
      }
      const tell = gateway.beforeViewChange();
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
      tell();
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
      const tell = gateway.beforeViewChange();
      folderRules = next.projects;
      tell();
      manager.setIdleUnderPressure(next.mcpd.idleUnderPressure);
      if (next.mcpd.callLog !== Boolean(calls)) {
        if (calls) {
          calls.close();
          calls = undefined;
        } else calls = createCallLog(files.calls, { onError: (m) => log(m) });
        log(`call log ${calls ? "on" : "off"} (${why})`);
      }
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
          debounce = setTimeout(
            () => void reload("mcp.toml changed").catch((e) => log(`reload failed: ${(e as Error).message}`)),
            300,
          );
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
      gateway.pruneSessions(pidAlive);
      manager
        .reap()
        .then((stopped) => {
          for (const s of stopped) log(`reaped ${s}`);
        })
        .catch((err) => log(`reap failed: ${(err as Error).message}`));
      void sampler.sample(manager.list().map((i) => ({ descKey: i.descKey, pid: i.upstream.pid })));
    }, 15_000);
    timer.unref();
    // /status shows the pressure from the start instead of after the first reap.
    void manager.readPressure().catch(() => {});

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
        // Rotated OAuth tokens the secret store refused so far: one last try before they are gone.
        const lost = await Promise.race([
          manager.flushLogins().catch(() => [] as string[]),
          new Promise<string[]>((r) => setTimeout(() => r([]), 3000).unref()),
        ]);
        if (lost.length)
          log(`OAuth tokens not saved, a new login is needed for: ${lost.join(", ")} (turno mcp login <server>)`);
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
