import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../core/config.js";
import { type Manifest, loadManifest } from "../core/manifest.js";
import { paths } from "../core/paths.js";
import { keychainResolver } from "../core/secrets.js";
import { DescriptionCache } from "./cache.js";
import { type BuiltinFactory, DefaultConnector } from "./connectors.js";
import { Gateway } from "./gateway.js";
import { InstanceManager, descriptionFingerprint, processAlive } from "./instances.js";
import { peerPid } from "./peerpid.js";

/** The bearer token sessions use; created once with mode 600. */
export function ensureToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = paths(env).mcpdToken;
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* create it */
  }
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function readToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return readFileSync(paths(env).mcpdToken, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The port mcpd listens on: the one it recorded, else the configured one. */
export function mcpdPort(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const n = Number.parseInt(readFileSync(paths(env).mcpdPort, "utf8"), 10);
    if (n > 0) return n;
  } catch {
    /* fall through */
  }
  return loadConfig(env).mcpd.port;
}

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

export interface RunningDaemon {
  port: number;
  gateway: Gateway;
  manager: InstanceManager;
  stop(): Promise<void>;
}

/** Start mcpd in this process. Used by `claudio mcpd run` (foreground or under launchd). */
export async function startDaemon(opts: { env?: NodeJS.ProcessEnv; port?: number; logToStdout?: boolean } = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const p = paths(env);
  mkdirSync(p.logsDir, { recursive: true });
  const logFile = join(p.logsDir, "mcpd.log");
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    if (opts.logToStdout) process.stdout.write(text);
    else appendFileSync(logFile, text);
  };

  let manifest: Manifest = loadManifest(env);
  const config = loadConfig(env);
  const token = ensureToken(env);
  const manager = new InstanceManager({
    cache: new DescriptionCache(p.mcpdCacheDir),
    connector: new DefaultConnector({
      resolve: keychainResolver(env),
      serversDir: p.serversDir,
      logsDir: p.logsDir,
      builtins: await loadBuiltins(),
      baseEnv: Object.fromEntries(
        ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"].flatMap((k) => (env[k] ? [[k, env[k] as string]] : [])),
      ),
    }),
    home: p.home,
    log,
  });
  const gateway = new Gateway({ manager, manifest: () => manifest, token, peerPid, log });

  const wanted = opts.port ?? config.mcpd.port;
  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      port = await gateway.listen(wanted === 0 ? 0 : wanted + attempt);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw err;
    }
  }
  if (!port) throw new Error(`no free port from ${wanted}`);
  mkdirSync(dirname(p.mcpdPort), { recursive: true });
  writeFileSync(p.mcpdPort, `${port}\n`);
  log(`mcpd listening on 127.0.0.1:${port} with ${Object.keys(manifest.servers).length} servers`);

  const reload = async (why: string) => {
    let next: Manifest;
    try {
      next = loadManifest(env);
    } catch (err) {
      log(`reload skipped (${why}): ${(err as Error).message}`);
      return;
    }
    // Stop instances whose definition changed or disappeared; the next call starts the new one.
    for (const inst of manager.list()) {
      const def = next.servers[inst.server.name];
      if (!def || descriptionFingerprint(def, inst.variant) !== descriptionFingerprint(inst.server, inst.variant)) {
        await manager.stop(inst.key);
        log(`stopped ${inst.upstream.label} after manifest change`);
      }
    }
    manifest = next;
    log(`manifest reloaded (${why}): ${Object.keys(manifest.servers).length} servers`);
  };

  let debounce: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  if (existsSync(p.config)) {
    watcher = watch(p.config, (_event, file) => {
      if (file !== "mcp.toml") return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void reload("mcp.toml changed"), 300);
    });
  }
  const onHup = () => void reload("SIGHUP");
  process.on("SIGHUP", onHup);

  const timer = setInterval(() => {
    gateway.pruneSessions(processAlive);
    manager
      .reap()
      .then((stopped) => stopped.forEach((s) => log(`reaped ${s}`)))
      .catch((err) => log(`reap failed: ${(err as Error).message}`));
  }, 15_000);
  timer.unref();

  return {
    port,
    gateway,
    manager,
    async stop() {
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
      process.off("SIGHUP", onHup);
      await manager.stopAll();
      await gateway.close();
      log("mcpd stopped");
    },
  };
}
