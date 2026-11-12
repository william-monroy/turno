import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerDef, StdioServer } from "../core/manifest.js";
import { effectiveLaunch, variantKey } from "../core/manifest.js";
import type { SecretResolver } from "../core/secrets.js";
import { resolveRecord } from "../core/secrets.js";
import { type DescriptionCache, type ServerDescription, fingerprint } from "./cache.js";
import { ErrorCode, rpcError, type Outcome } from "./jsonrpc.js";
import { type ClientPort, Upstream } from "./upstream.js";

/** Who is calling: one Claude Code MCP session against one server. */
export interface ClientContext {
  server: ServerDef;
  profile?: string;
  pid?: number;
  cwd?: string;
  sessionId: string;
}

export interface ClientHandle extends ClientPort {
  ctx: ClientContext;
  lastSeen: number;
}

/** Builds the transport for a server; injectable so tests and builtins can plug in. */
export interface Connector {
  connect(server: ServerDef, variant: string, ctx: ClientContext, workdir: string): Promise<{ transport: Transport; pid?: () => number | null | undefined }>;
}

export interface Instance {
  key: string;
  descKey: string;
  server: ServerDef;
  variant: string;
  upstream: Upstream;
  clients: Set<ClientHandle>;
  /** Exclusive servers: the session holding the lease. */
  holder?: ClientHandle;
  holderSince?: number;
  /** PID the instance belongs to (session scope). */
  pid?: number;
  workdir: string;
}

export interface ManagerOptions {
  cache: DescriptionCache;
  connector: Connector;
  home: string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Git top level of a folder (worktree-specific), else the folder itself. */
export function projectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  }
}

export function variantOf(server: ServerDef, profile: string | undefined): string {
  return server.kind === "stdio" ? variantKey(server, profile) : "default";
}

export function scopeOf(server: ServerDef): "shared" | "project" | "session" {
  if (server.kind === "remote") return "shared";
  if (server.builtin) return "session";
  return server.scope;
}

export function descriptionFingerprint(server: ServerDef, variant: string): string {
  if (server.kind === "remote") return fingerprint({ url: server.url, headers: Object.keys(server.headers) });
  const launch = effectiveLaunch(server, variant);
  return fingerprint({ c: launch.command, a: launch.args, e: launch.env, v: variant, p: server.package ?? null, b: server.builtin ?? null });
}

/**
 * Owns every running upstream. Starts them lazily, shares or isolates them by scope,
 * hands out exclusive leases, and stops them when their owner dies or they go idle.
 */
export class InstanceManager {
  private instances = new Map<string, Instance>();
  private starting = new Map<string, Promise<Instance>>();
  private describing = new Map<string, Promise<ServerDescription>>();
  private clients = new Set<ClientHandle>();
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(private readonly opts: ManagerOptions) {
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? Date.now;
  }

  register(client: ClientHandle): void {
    this.clients.add(client);
  }

  /** A client session ended: drop it from every instance and release its leases. */
  detach(client: ClientHandle): void {
    this.clients.delete(client);
    for (const inst of this.instances.values()) {
      if (inst.clients.delete(client)) inst.upstream.forgetClient(client);
      if (inst.holder === client) {
        delete inst.holder;
        delete inst.holderSince;
      }
    }
  }

  keyOf(ctx: ClientContext): { key: string; descKey: string; variant: string; workdir: string; pid?: number } {
    const s = ctx.server;
    const variant = variantOf(s, ctx.profile);
    const descKey = `${s.name}@${variant}`;
    const scope = scopeOf(s);
    if (scope === "shared") return { key: `${s.name}|${variant}`, descKey, variant, workdir: this.opts.home };
    if (scope === "project") {
      const root = ctx.cwd ? projectRoot(ctx.cwd) : this.opts.home;
      return { key: `${s.name}|${variant}|root:${root}`, descKey, variant, workdir: root };
    }
    const workdir = ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : this.opts.home;
    if (ctx.pid) return { key: `${s.name}|${variant}|pid:${ctx.pid}`, descKey, variant, workdir, pid: ctx.pid };
    return { key: `${s.name}|${variant}|sid:${ctx.sessionId}`, descKey, variant, workdir };
  }

  /** Description for initialize and the list methods: cached, else from a (kept) running instance. */
  async describe(client: ClientHandle): Promise<ServerDescription> {
    const { descKey, variant } = this.keyOf(client.ctx);
    const fp = descriptionFingerprint(client.ctx.server, variant);
    const cached = this.opts.cache.get(descKey, fp);
    if (cached) return cached;
    let p = this.describing.get(descKey);
    if (!p) {
      p = (async () => {
        const inst = await this.instanceFor(client, false);
        return this.refreshDescription(inst);
      })();
      this.describing.set(descKey, p);
      p.finally(() => this.describing.delete(descKey)).catch(() => {});
    }
    return p;
  }

  /** The instance that serves a real request from this client (starts it, checks leases). */
  async acquire(client: ClientHandle): Promise<Instance | Outcome> {
    let inst: Instance;
    try {
      inst = await this.instanceFor(client, true);
    } catch (err) {
      return rpcError(ErrorCode.Unavailable, `could not start ${client.ctx.server.name}: ${(err as Error).message}`);
    }
    const s = client.ctx.server;
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

  /** Instance already serving this client, if any (no start). */
  existing(client: ClientHandle): Instance | undefined {
    const inst = this.instances.get(this.keyOf(client.ctx).key);
    return inst && !inst.upstream.isClosed ? inst : undefined;
  }

  async refreshDescription(inst: Instance): Promise<ServerDescription> {
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
    if (caps.resources) {
      d.resources = await inst.upstream.listAll("resources/list", "resources");
      d.resourceTemplates = await inst.upstream.listAll("resources/templates/list", "resourceTemplates").catch(() => []);
    }
    this.opts.cache.set(inst.descKey, d);
    return d;
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
      p = this.start(client.ctx, k);
      this.starting.set(k.key, p);
      p.finally(() => this.starting.delete(k.key)).catch(() => {});
    }
    const inst = await p;
    if (join) inst.clients.add(client);
    return inst;
  }

  private async start(ctx: ClientContext, k: ReturnType<InstanceManager["keyOf"]>): Promise<Instance> {
    const server = ctx.server;
    const { transport, pid } = await this.opts.connector.connect(server, k.variant, ctx, k.workdir);
    let inst!: Instance;
    const upstream = new Upstream({
      label: `${server.name}${k.variant === "default" ? "" : `@${k.variant}`}`,
      connect: async () => transport,
      pid,
      onBroadcast: (method, params) => this.onBroadcast(inst, method, params),
      onClose: (reason) => {
        if (this.instances.get(k.key) === inst) this.instances.delete(k.key);
        this.opts.log?.(`stopped ${inst.upstream.label} (${reason})`);
      },
    });
    inst = {
      key: k.key,
      descKey: k.descKey,
      server,
      variant: k.variant,
      upstream,
      clients: new Set(),
      workdir: k.workdir,
      ...(k.pid ? { pid: k.pid } : {}),
    };
    await upstream.start();
    this.instances.set(k.key, inst);
    this.opts.log?.(`started ${upstream.label} pid=${upstream.pid ?? "-"} key=${k.key}`);
    return inst;
  }

  private onBroadcast(inst: Instance, method: string, params: Record<string, unknown> | undefined): void {
    if (method.endsWith("/list_changed")) {
      this.refreshDescription(inst)
        .then(() => {
          for (const c of this.clients) {
            if (this.keyOf(c.ctx).descKey === inst.descKey) c.notify(method, params);
          }
        })
        .catch((err) => this.opts.log?.(`refresh ${inst.upstream.label} failed: ${(err as Error).message}`));
      return;
    }
    for (const c of inst.clients) c.notify(method, params);
  }

  private expireLease(inst: Instance): void {
    const s = inst.server;
    if (!inst.holder || s.kind !== "stdio") return;
    const h = inst.holder;
    const dead = h.ctx.pid ? !this.isAlive(h.ctx.pid) : false;
    const idle = this.now() - h.lastSeen > s.lease * 1000;
    if (dead || idle || !this.clients.has(h)) {
      delete inst.holder;
      delete inst.holderSince;
    }
  }

  /** Stop instances whose owner died or that sat idle too long; forget dead clients. */
  async reap(): Promise<string[]> {
    const stopped: string[] = [];
    for (const c of [...this.clients]) {
      if (c.ctx.pid && !this.isAlive(c.ctx.pid)) this.detach(c);
    }
    for (const inst of [...this.instances.values()]) {
      this.expireLease(inst);
      const s = inst.server;
      const idleLimit = (s.kind === "stdio" ? s.idle : s.idle) * 1000;
      const ownerDead = inst.pid !== undefined && !this.isAlive(inst.pid);
      const idle = inst.upstream.inflight === 0 && this.now() - inst.upstream.lastActivity > idleLimit;
      if (ownerDead || idle) {
        this.instances.delete(inst.key);
        await inst.upstream.close();
        stopped.push(`${inst.upstream.label}: ${ownerDead ? "owner exited" : "idle"}`);
      }
    }
    return stopped;
  }

  list(): Instance[] {
    return [...this.instances.values()];
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

/** Resolve a command against an installed package (claudio mcp install) or PATH. */
export function resolveCommand(server: StdioServer, command: string, serversDir: string): string {
  if (server.package) {
    const local = join(serversDir, server.name, "node_modules", ".bin", command);
    if (existsSync(local)) return local;
  }
  return command;
}

export async function resolvedEnv(server: StdioServer, variant: string, resolve: SecretResolver): Promise<Record<string, string>> {
  return resolveRecord(effectiveLaunch(server, variant).env, resolve);
}
