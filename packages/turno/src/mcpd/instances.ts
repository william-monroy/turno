import { execFile } from "node:child_process";
import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Manifest, ServerDef, StdioServer } from "../core/manifest.js";
import { effectiveLaunch, variantKey } from "../core/manifest.js";
import type { SecretResolver } from "../core/secrets.js";
import { resolveRecord } from "../core/secrets.js";
import { type DescriptionCache, type ServerDescription, fingerprint } from "./cache.js";
import type { CallEvent } from "./calllog.js";
import { ErrorCode, type Id, rpcError, type Outcome } from "./jsonrpc.js";
import { LoginRequiredError } from "./oauth.js";
import { type PressureLevel, type PressureProbe, effectiveIdle } from "./pressure.js";
import { type ClientPort, Upstream } from "./upstream.js";

const run = promisify(execFile);

/**
 * Who is calling: one MCP client session against one server. Only the server's name is kept:
 * its definition is looked up in the current manifest on every use, so a reload applies to
 * sessions that are already open (ADR 0016).
 */
export interface ClientContext {
  serverName: string;
  profile?: string;
  pid?: number;
  /** The session folder, decoded and checked to exist. */
  cwd?: string;
  /** Git top level of `cwd` (else `cwd`), computed once when the session is created. */
  projectRoot?: string;
  sessionId: string;
  /** What the downstream client declared in initialize (elicitation, roots, ...). Unknown when undefined. */
  clientCapabilities?: Record<string, unknown>;
  /** The client's name from initialize (clientInfo.name), for the call log. */
  clientName?: string;
}

export interface ClientHandle extends ClientPort {
  ctx: ClientContext;
  lastSeen: number;
  /**
   * A 2026-07-28 `subscriptions/listen` stream (ADR 0028): it gets the resource list changes of
   * its server even though it never joined an instance.
   */
  listening?: boolean;
}

/** Builds the transport for a server; injectable so tests and builtins can plug in. */
export interface Connector {
  connect(
    server: ServerDef,
    variant: string,
    ctx: ClientContext,
    workdir: string,
  ): Promise<{ transport: Transport; pid?: () => number | null | undefined; warnings?: string[] }>;
  /** Last lines of the server's own log, shown when it keeps failing to start. */
  logTail?(server: ServerDef, variant: string, lines?: number): string | undefined;
}

export type Scope = "shared" | "project" | "session";

export interface Instance {
  key: string;
  descKey: string;
  /** The definition this instance was started with. */
  server: ServerDef;
  /** Fingerprint of that definition; a reload that changes it retires the instance. */
  defFp: string;
  scope: Scope;
  variant: string;
  upstream: Upstream;
  clients: Set<ClientHandle>;
  /** Exclusive servers: the session holding the lease. */
  holder?: ClientHandle;
  holderSince?: number;
  /** PID the instance belongs to (session scope). */
  pid?: number;
  workdir: string;
  /** Whether workdir is the session's real folder (not the home fallback). */
  workdirKnown: boolean;
  /** resources/subscribe per URI: which clients asked. */
  subscriptions: Map<string, Set<ClientHandle>>;
  /** The description relisted right after the start. */
  described?: Promise<ServerDescription>;
}

export interface ManagerOptions {
  cache: DescriptionCache;
  connector: Connector;
  home: string;
  /** The current manifest; the gateway wires it when it is not given here. */
  manifest?: () => Manifest;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Consecutive start failures before the circuit breaker opens (default 3). */
  breakerThreshold?: number;
  /** First backoff once the breaker is open, doubled on each further failure (default 5 s, max 5 min). */
  breakerBaseMs?: number;
  /** Called after every relayed request settles (the call log, ADR 0026). Must not throw. */
  onCall?: (event: CallEvent) => void;
  /** Reads memory pressure before each reap (ADR 0028); without it the pressure is always normal. */
  pressure?: PressureProbe;
  /** Idle limit in seconds while memory is tight (`[mcpd] idle_under_pressure`); 0 or unset turns it off. */
  idleUnderPressure?: number;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Results of slow lookups, keyed and shared by concurrent callers (a client opens many sessions at once). */
function memo<K, V>(ttlMs: number, compute: (key: K) => Promise<V>): (key: K, now?: number) => Promise<V> {
  const cache = new Map<K, { value: Promise<V>; at: number }>();
  return (key, now = Date.now()) => {
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    if (cache.size > 500) cache.clear();
    const value = compute(key);
    cache.set(key, { value, at: now });
    return value;
  };
}

/** Git top level of a folder (worktree-specific), else the folder itself. Async, cached for 10 s. */
export const projectRoot: (cwd: string, now?: number) => Promise<string> = memo(10_000, async (cwd: string) => {
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000 });
    return stdout.trim() || cwd;
  } catch {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  }
});

/** Current folder of a process: /proc on Linux, lsof elsewhere. Cached per PID for a minute. */
export const processCwd: (pid: number, now?: number) => Promise<string | undefined> = memo(60_000, async (pid: number) => {
  if (existsSync("/proc/self/cwd")) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
});

/** Stdio servers and OAuth remotes have variants per profile; other remotes have only "default". */
export function variantOf(server: ServerDef, profile: string | undefined): string {
  return variantKey(server, profile);
}

export function scopeOf(server: ServerDef): Scope {
  if (server.kind === "remote") return "shared";
  if (server.builtin) return "session";
  return server.scope;
}

export function descriptionFingerprint(server: ServerDef, variant: string): string {
  if (server.kind === "remote") return fingerprint({ url: server.url, headers: Object.keys(server.headers) });
  const launch = effectiveLaunch(server, variant);
  return fingerprint({ c: launch.command, a: launch.args, e: launch.env, v: variant, p: server.package ?? null, b: server.builtin ?? null });
}

/** Fingerprint of the whole definition (launch, scope, cwd, exclusive, idle, lease, timeouts), except who gets it. */
export function definitionFingerprint(server: ServerDef): string {
  return fingerprint({ ...server, profiles: null });
}

/** A server that is gone from the manifest (or no longer proxied) while sessions still use it. */
export class ServerGoneError extends Error {}

interface Breaker {
  failures: number;
  until: number;
  lastError: string;
}

const LIST_NOTIFICATIONS: [keyof ServerDescription, string][] = [
  ["tools", "notifications/tools/list_changed"],
  ["prompts", "notifications/prompts/list_changed"],
  ["resourceTemplates", "notifications/resources/list_changed"],
];

/**
 * Owns every running upstream. Starts them lazily, shares or isolates them by scope,
 * hands out exclusive leases, and stops them when their owner dies or they go idle.
 */
export class InstanceManager {
  private instances = new Map<string, Instance>();
  private starting = new Map<string, Promise<Instance>>();
  private describing = new Map<string, Promise<ServerDescription>>();
  private clients = new Set<ClientHandle>();
  private breakers = new Map<string, Breaker>();
  /** Starts per instance key since mcpd started; more than one means restarts. */
  private starts = new Map<string, number>();
  private manifest?: () => Manifest;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  /** When this manager started: descriptions relisted since then were checked against a running server. */
  readonly bornAt: number;
  /** The memory pressure seen by the last reap. */
  pressureLevel: PressureLevel = "normal";

  constructor(private readonly opts: ManagerOptions) {
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? Date.now;
    this.bornAt = this.now();
    if (opts.manifest) this.manifest = opts.manifest;
  }

  /** Where definitions come from (the gateway passes its manifest getter). */
  useManifest(manifest: () => Manifest): void {
    this.manifest ??= manifest;
  }

  register(client: ClientHandle): void {
    this.clients.add(client);
  }

  /** A client session ended: cancel its calls, drop it from every instance and release its leases. */
  detach(client: ClientHandle): void {
    this.clients.delete(client);
    for (const inst of this.instances.values()) {
      const cancelled = inst.upstream.forgetClient(client);
      if (cancelled) this.opts.log?.(`cancelled ${cancelled} call(s) of a closed session on ${inst.upstream.label}`);
      inst.clients.delete(client);
      for (const [uri, subs] of inst.subscriptions) {
        if (subs.delete(client) && subs.size === 0) {
          inst.subscriptions.delete(uri);
          void inst.upstream.call("resources/unsubscribe", { uri }, undefined, undefined, 30_000);
        }
      }
      if (inst.holder === client) {
        delete inst.holder;
        delete inst.holderSince;
      }
    }
  }

  /** The current definition of the server a session talks to. */
  serverOf(ctx: ClientContext): ServerDef {
    const def = this.manifest?.().servers[ctx.serverName];
    if (!def || (def.kind === "remote" && !def.proxy)) {
      throw new ServerGoneError(`${ctx.serverName} is no longer served by mcpd (removed from mcp.toml); restart the session to drop it`);
    }
    return def;
  }

  keyOf(ctx: ClientContext): { key: string; descKey: string; variant: string; workdir: string; workdirKnown: boolean; pid?: number; server: ServerDef; scope: Scope; defFp: string } {
    const s = this.serverOf(ctx);
    const variant = variantOf(s, ctx.profile);
    const descKey = `${s.name}@${variant}`;
    const scope = scopeOf(s);
    const defFp = definitionFingerprint(s);
    const base = { descKey, variant, server: s, scope, defFp };
    const head = `${s.name}|${variant}|${defFp}`;
    if (scope === "shared") return { ...base, key: head, workdir: this.opts.home, workdirKnown: false };
    if (scope === "project") {
      const root = ctx.projectRoot ?? ctx.cwd;
      return { ...base, key: `${head}|root:${root ?? this.opts.home}`, workdir: root ?? this.opts.home, workdirKnown: root !== undefined };
    }
    const workdir = ctx.cwd ?? this.opts.home;
    const workdirKnown = ctx.cwd !== undefined;
    if (ctx.pid) return { ...base, key: `${head}|pid:${ctx.pid}`, workdir, workdirKnown, pid: ctx.pid };
    return { ...base, key: `${head}|sid:${ctx.sessionId}`, workdir, workdirKnown };
  }

  /** Description for initialize and the list methods: cached, else from a (kept) running instance. */
  async describe(client: ClientHandle): Promise<ServerDescription> {
    const { descKey, variant, server } = this.keyOf(client.ctx);
    const fp = descriptionFingerprint(server, variant);
    const cached = this.opts.cache.get(descKey, fp);
    if (cached) return cached;
    let p = this.describing.get(descKey);
    if (!p) {
      p = (async () => {
        const inst = await this.instanceFor(client, false);
        return inst.described ?? this.relist(inst);
      })();
      this.describing.set(descKey, p);
      p.finally(() => this.describing.delete(descKey)).catch(() => {});
    }
    return p;
  }

  /** The cached description for this client's server, without starting anything. */
  cachedDescription(client: ClientHandle): ServerDescription | undefined {
    const { descKey, variant, server } = this.keyOf(client.ctx);
    return this.opts.cache.get(descKey, descriptionFingerprint(server, variant));
  }

  /** Whether a description was relisted from a running server since this manager started. */
  verified(d: ServerDescription): boolean {
    return d.updatedAt >= this.bornAt;
  }

  /** The instance that serves a real request from this client (starts it, checks leases). */
  async acquire(client: ClientHandle): Promise<Instance | Outcome> {
    let inst: Instance;
    try {
      inst = await this.instanceFor(client, true);
    } catch (err) {
      if (err instanceof ServerGoneError) return rpcError(ErrorCode.Unavailable, err.message);
      return rpcError(ErrorCode.Unavailable, `could not start ${client.ctx.serverName}: ${(err as Error).message}`);
    }
    const s = inst.server;
    if (s.kind === "stdio" && s.exclusive) {
      this.expireLease(inst);
      if (inst.holder && inst.holder !== client) {
        const h = inst.holder.ctx;
        return rpcError(
          ErrorCode.Busy,
          `${s.name} is in use by another session (profile ${h.profile ?? "?"}, pid ${h.pid ?? "?"}) since ${new Date(inst.holderSince ?? 0).toLocaleTimeString("en-US", { hour12: false })}. Try again later or close that session.`,
        );
      }
      if (inst.holder !== client) {
        inst.holder = client;
        inst.holderSince = this.now();
      }
    }
    inst.clients.add(client);
    return inst;
  }

  /**
   * Relay one client request: start or join the instance, apply the server's call_timeout,
   * and retry once on a fresh instance when a remote server forgot our session.
   */
  async forward(client: ClientHandle, method: string, params: Record<string, unknown> | undefined, originId: Id): Promise<Outcome> {
    const startedAt = Date.now();
    const t0 = performance.now();
    let variant: string | undefined;
    const done = (outcome: Outcome): Outcome => {
      try {
        this.opts.onCall?.({ ctx: client.ctx, method, params, ...(variant ? { variant } : {}), outcome, startedAt, durationMs: performance.now() - t0 });
      } catch {
        /* observing a call never fails it */
      }
      return outcome;
    };
    for (let attempt = 0; ; attempt++) {
      const inst = await this.acquire(client);
      if ("error" in inst || "result" in inst) return done(inst as Outcome);
      variant = inst.variant;
      const timeout = inst.server.callTimeout ? inst.server.callTimeout * 1000 : undefined;
      const out = await inst.upstream.call(method, params, client, originId, timeout);
      if ("error" in out && inst.upstream.sessionLost && attempt === 0) {
        this.opts.log?.(`${inst.upstream.label}: remote session expired; reconnecting and retrying ${method}`);
        if (this.instances.get(inst.key) === inst) this.instances.delete(inst.key);
        continue;
      }
      return done(out);
    }
  }

  /** resources/subscribe: one upstream subscription per URI and instance, many client subscribers. */
  async subscribe(client: ClientHandle, uri: string, originId: Id): Promise<Outcome> {
    const inst = await this.acquire(client);
    if ("error" in inst || "result" in inst) return inst as Outcome;
    let subs = inst.subscriptions.get(uri);
    if (!subs) {
      const out = await inst.upstream.call("resources/subscribe", { uri }, client, originId);
      if ("error" in out) return out;
      subs = inst.subscriptions.get(uri) ?? new Set();
      inst.subscriptions.set(uri, subs);
    }
    subs.add(client);
    return { result: {} };
  }

  async unsubscribe(client: ClientHandle, uri: string, originId: Id): Promise<Outcome> {
    const inst = this.existing(client);
    const subs = inst?.subscriptions.get(uri);
    if (!inst || !subs?.delete(client)) return { result: {} };
    if (subs.size > 0) return { result: {} };
    inst.subscriptions.delete(uri);
    return inst.upstream.call("resources/unsubscribe", { uri }, client, originId);
  }

  /** Instance already serving this client, if any (no start). */
  existing(client: ClientHandle): Instance | undefined {
    const inst = this.instances.get(this.keyOf(client.ctx).key);
    return inst && !inst.upstream.isClosed ? inst : undefined;
  }

  /** List tools, prompts and resource templates again; store them and tell clients what changed. */
  async relist(inst: Instance, quiet: string[] = []): Promise<ServerDescription> {
    const init = inst.upstream.init;
    if (!init) throw new Error(`${inst.server.name} is not initialized`);
    const caps = init.capabilities;
    const d: ServerDescription = {
      fingerprint: descriptionFingerprint(inst.server, inst.variant),
      serverInfo: init.serverInfo,
      capabilities: caps,
      ...(init.instructions ? { instructions: init.instructions } : {}),
      updatedAt: this.now(),
    };
    if (caps.tools) d.tools = await inst.upstream.listAll("tools/list", "tools");
    if (caps.prompts) d.prompts = await inst.upstream.listAll("prompts/list", "prompts");
    if (caps.resources) d.resourceTemplates = await inst.upstream.listAll("resources/templates/list", "resourceTemplates").catch(() => []);
    const prev = this.opts.cache.peek(inst.descKey);
    this.opts.cache.set(inst.descKey, d);
    if (prev) {
      const changed = LIST_NOTIFICATIONS.filter(([k, m]) => !quiet.includes(m) && JSON.stringify(prev[k] ?? null) !== JSON.stringify(d[k] ?? null));
      if (changed.length) {
        this.opts.log?.(`${inst.upstream.label}: ${changed.map(([k]) => k).join(", ")} changed; notifying clients`);
        for (const c of this.clientsOf(inst.descKey)) for (const [, m] of changed) c.notify(m, undefined);
      }
    }
    return d;
  }

  /**
   * `POST /refresh/<server>`: relist running instances (clients get list_changed when it
   * changed) and forget the cached description of variants that are not running.
   */
  async refresh(name: string): Promise<{ refreshed: string[]; forgotten: string[]; errors: Record<string, string> }> {
    const def = this.manifest?.().servers[name];
    const variants = def ? ["default", ...Object.keys(def.variants)] : ["default"];
    const out = { refreshed: [] as string[], forgotten: [] as string[], errors: {} as Record<string, string> };
    for (const variant of variants) {
      const descKey = `${name}@${variant}`;
      const running = this.list().find((i) => i.descKey === descKey && !i.upstream.isClosed && i.upstream.init);
      if (running) {
        try {
          await this.relist(running);
          out.refreshed.push(descKey);
        } catch (err) {
          out.errors[descKey] = (err as Error).message;
        }
      } else if (this.opts.cache.forget(descKey)) {
        out.forgotten.push(descKey);
      }
    }
    return out;
  }

  private clientsOf(descKey: string): ClientHandle[] {
    return [...this.clients].filter((c) => {
      try {
        return this.keyOf(c.ctx).descKey === descKey;
      } catch {
        return false;
      }
    });
  }

  private async instanceFor(client: ClientHandle, join: boolean): Promise<Instance> {
    const k = this.keyOf(client.ctx);
    const existing = this.instances.get(k.key);
    if (existing && !existing.upstream.isClosed) {
      if (join) existing.clients.add(client);
      return existing;
    }
    let p = this.starting.get(k.key);
    if (!p) {
      p = this.startGuarded(client.ctx, k);
      this.starting.set(k.key, p);
      p.finally(() => this.starting.delete(k.key)).catch(() => {});
    }
    const inst = await p;
    if (join) inst.clients.add(client);
    return inst;
  }

  /** Circuit breaker: after repeated start failures, answer at once with the log tail and back off. */
  private async startGuarded(ctx: ClientContext, k: ReturnType<InstanceManager["keyOf"]>): Promise<Instance> {
    const bkey = `${k.server.name}|${k.variant}|${k.defFp}`;
    const b = this.breakers.get(bkey);
    const now = this.now();
    if (b && b.until > now) throw new Error(this.breakerMessage(k, b, now));
    try {
      const inst = await this.start(ctx, k);
      this.breakers.delete(bkey);
      return inst;
    } catch (err) {
      // A missing OAuth login is not a crash: no backoff, so the call after `turno mcp login` works.
      if (err instanceof LoginRequiredError) throw err;
      const message = (err as Error).message;
      const failures = (b?.failures ?? 0) + 1;
      const threshold = this.opts.breakerThreshold ?? 3;
      const base = this.opts.breakerBaseMs ?? 5000;
      const until = failures >= threshold ? this.now() + Math.min(base * 2 ** (failures - threshold), 5 * 60_000) : 0;
      this.breakers.set(bkey, { failures, until, lastError: message });
      if (failures >= threshold) this.opts.log?.(`${k.server.name}: ${failures} failed starts in a row; next try in ${Math.round((until - this.now()) / 1000)}s`);
      throw err;
    }
  }

  private breakerMessage(k: ReturnType<InstanceManager["keyOf"]>, b: Breaker, now: number): string {
    const tail = this.opts.connector.logTail?.(k.server, k.variant, 10);
    return (
      `${k.server.name} failed to start ${b.failures} times in a row (last error: ${b.lastError}); ` +
      `turno tries again in ${Math.max(1, Math.round((b.until - now) / 1000))}s.` +
      (tail ? `\nLast lines of its log:\n${tail}` : "")
    );
  }

  /** Client capabilities to declare upstream: only what the client behind it can honor. */
  private upstreamCapabilities(ctx: ClientContext, scope: Scope): Record<string, unknown> {
    const cc = ctx.clientCapabilities;
    const caps: Record<string, unknown> = {};
    // Shared instances serve many folders: there is no single right answer to roots/list.
    if (scope !== "shared") caps.roots = { listChanged: true };
    if (cc === undefined) caps.elicitation = { form: {} };
    else if (cc.elicitation) caps.elicitation = cc.elicitation;
    if (cc?.sampling) caps.sampling = cc.sampling;
    return caps;
  }

  private async start(ctx: ClientContext, k: ReturnType<InstanceManager["keyOf"]>): Promise<Instance> {
    const server = k.server;
    const { transport, pid, warnings } = await this.opts.connector.connect(server, k.variant, ctx, k.workdir);
    for (const w of warnings ?? []) this.opts.log?.(`warning: ${w}`);
    let inst!: Instance;
    const upstream = new Upstream({
      label: `${server.name}${k.variant === "default" ? "" : `@${k.variant}`}`,
      connect: async () => transport,
      ...(pid ? { pid } : {}),
      capabilities: this.upstreamCapabilities(ctx, k.scope),
      localRoots: () =>
        inst && inst.scope !== "shared" && inst.workdirKnown
          ? { roots: [{ uri: pathToFileURL(inst.workdir).href, name: basename(inst.workdir) || inst.workdir }] }
          : undefined,
      attached: () => (inst ? [...inst.clients] : []),
      onBroadcast: (method, params) => this.onBroadcast(inst, method, params),
      onClose: (reason) => {
        if (this.instances.get(k.key) === inst) this.instances.delete(k.key);
        this.opts.log?.(`stopped ${inst.upstream.label} (${reason})`);
      },
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    inst = {
      key: k.key,
      descKey: k.descKey,
      server,
      defFp: k.defFp,
      scope: k.scope,
      variant: k.variant,
      upstream,
      clients: new Set(),
      workdir: k.workdir,
      workdirKnown: k.workdirKnown,
      subscriptions: new Map(),
      ...(k.pid ? { pid: k.pid } : {}),
    };
    await upstream.start();
    this.instances.set(k.key, inst);
    this.starts.set(k.key, (this.starts.get(k.key) ?? 0) + 1);
    this.opts.log?.(`started ${upstream.label} pid=${upstream.pid ?? "-"} key=${k.key}`);
    // Every real start relists: a server updated in place (npx, uvx, a new build) shows its new tools.
    inst.described = this.relist(inst);
    inst.described.catch((err) => this.opts.log?.(`relist ${upstream.label} failed: ${(err as Error).message}`));
    return inst;
  }

  private onBroadcast(inst: Instance, method: string, params: Record<string, unknown> | undefined): void {
    if (method === "notifications/resources/updated") {
      const uri = typeof params?.uri === "string" ? params.uri : "";
      for (const c of inst.subscriptions.get(uri) ?? []) c.notify(method, params);
      return;
    }
    if (method === "notifications/resources/list_changed") {
      // Resources are not cached: tell this instance's clients (and listen streams), then refresh the templates quietly.
      const targets = new Set<ClientHandle>(inst.clients);
      for (const c of this.clientsOf(inst.descKey)) if (c.listening) targets.add(c);
      for (const c of targets) c.notify(method, params);
      this.relist(inst, [method]).catch((err) => this.opts.log?.(`refresh ${inst.upstream.label} failed: ${(err as Error).message}`));
      return;
    }
    if (method.endsWith("/list_changed")) {
      this.relist(inst).catch((err) => this.opts.log?.(`refresh ${inst.upstream.label} failed: ${(err as Error).message}`));
      return;
    }
    for (const c of inst.clients) c.notify(method, params);
  }

  private expireLease(inst: Instance): void {
    const s = inst.server;
    if (!inst.holder || s.kind !== "stdio") return;
    const h = inst.holder;
    const dead = h.ctx.pid ? !this.isAlive(h.ctx.pid) : false;
    // A long call keeps the lease: the holder is busy, not idle.
    const idle = inst.upstream.inflightFor(h) === 0 && this.now() - h.lastSeen > s.lease * 1000;
    if (dead || idle || !this.clients.has(h)) {
      delete inst.holder;
      delete inst.holderSince;
    }
  }

  /** Whether an instance still matches the manifest (false once its definition changed or went away). */
  private current(inst: Instance): boolean {
    if (!this.manifest) return true;
    const def = this.manifest().servers[inst.server.name];
    return def !== undefined && definitionFingerprint(def) === inst.defFp;
  }

  /** Read memory pressure; a failing probe counts as normal. Logs when the level changes. */
  private async pressure(): Promise<PressureLevel> {
    let level: PressureLevel = "normal";
    if (this.opts.pressure && (this.opts.idleUnderPressure ?? 0) > 0) {
      try {
        level = await this.opts.pressure();
      } catch {
        level = "normal";
      }
    }
    if (level !== this.pressureLevel) {
      const under = this.opts.idleUnderPressure ?? 0;
      this.opts.log?.(
        level === "normal"
          ? "memory pressure is normal again: servers keep their own idle limits"
          : `memory pressure is ${level}: idle servers stop after ${effectiveIdle(Number.POSITIVE_INFINITY, level, under)}s at most`,
      );
      this.pressureLevel = level;
    }
    return level;
  }

  /**
   * Stop instances whose owner died, whose definition changed, or that sat idle too long; forget
   * dead clients. Under memory pressure the idle limit shrinks (ADR 0028).
   */
  async reap(): Promise<string[]> {
    const stopped: string[] = [];
    const level = await this.pressure();
    for (const c of [...this.clients]) {
      if (c.ctx.pid && !this.isAlive(c.ctx.pid)) this.detach(c);
    }
    for (const inst of [...this.instances.values()]) {
      this.expireLease(inst);
      const quiet = inst.upstream.inflight === 0;
      const ownerAlive = inst.pid !== undefined && this.isAlive(inst.pid);
      const ownerDead = inst.pid !== undefined && !ownerAlive;
      const stale = quiet && !this.current(inst);
      // A session server lives as long as its session: its state (a browser, a login) is the point.
      const idleApplies = !(inst.scope === "session" && ownerAlive);
      const limit = effectiveIdle(inst.server.idle, level, this.opts.idleUnderPressure ?? 0);
      const idleFor = this.now() - inst.upstream.lastActivity;
      const idle = idleApplies && quiet && idleFor > limit * 1000;
      if (ownerDead || stale || idle) {
        const why = ownerDead ? "owner exited" : stale ? "definition changed" : idleFor > inst.server.idle * 1000 ? "idle" : "idle (memory pressure)";
        this.instances.delete(inst.key);
        // That key never comes back (dead PID, old definition): forget its start count.
        if (ownerDead || stale) this.starts.delete(inst.key);
        await inst.upstream.close();
        stopped.push(`${inst.upstream.label}: ${why}`);
      }
    }
    return stopped;
  }

  list(): Instance[] {
    return [...this.instances.values()];
  }

  /** How many times the instance under `key` started again after its first start. */
  restarts(key: string): number {
    return Math.max(0, (this.starts.get(key) ?? 0) - 1);
  }

  clientCount(): number {
    return this.clients.size;
  }

  async stopAll(): Promise<void> {
    const all = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(all.map((i) => i.upstream.close()));
  }

  async stop(key: string): Promise<boolean> {
    const inst = this.instances.get(key);
    if (!inst) return false;
    this.instances.delete(key);
    await inst.upstream.close();
    return true;
  }
}

/**
 * Resolve a command against an installed package (turno mcp install). A declared package that
 * is not installed still runs through `npx -y -p <package> <command>`, with a warning: `mcp
 * import` writes `package` and `mcp install` is a separate step, so failing here would break
 * imported setups (ADR 0016).
 */
export function resolveCommand(
  server: StdioServer,
  command: string,
  args: string[],
  serversDir: string,
): { command: string; args: string[]; warning?: string } {
  if (server.package) {
    const local = join(serversDir, server.name, "node_modules", ".bin", command);
    if (existsSync(local)) return { command: local, args };
    return {
      command: "npx",
      args: ["-y", "-p", server.package, command, ...args],
      warning: `${server.name}: package ${server.package} is not installed, so npx resolves and runs it at every start. Run \`turno mcp install ${server.name}\` to install it once.`,
    };
  }
  return { command, args };
}

export async function resolvedEnv(server: StdioServer, variant: string, resolve: SecretResolver): Promise<Record<string, string>> {
  return resolveRecord(effectiveLaunch(server, variant).env, resolve);
}
