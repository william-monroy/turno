import { randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from "node:http";
import { isAbsolute } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { type Manifest, type ToolFilter, filtersTools, servesProfile, toolAllowed, toolFilterFor } from "../core/manifest.js";
import type { ServerDescription } from "./cache.js";
import { cleanAgentName } from "./calllog.js";
import { type ClientContext, type ClientHandle, type InstanceManager, isDirectory, processCwd, projectRoot, scopeOf } from "./instances.js";
import { ErrorCode, type Id, type Message, type Outcome, isNotification, isRequest, isResponse, rpcError, toResponse } from "./jsonrpc.js";
import { tokenProfile } from "./tokens.js";

export interface GatewayOptions {
  manager: InstanceManager;
  manifest: () => Manifest;
  /**
   * The master token (ADR 0023). It opens only the admin endpoints (/status, /refresh); MCP
   * sessions authenticate with a profile token derived from it.
   */
  token: string;
  /** Finds the PID of a local TCP peer (lsof) when the session did not send one. */
  peerPid?: (remotePort: number) => Promise<number | undefined>;
  /** Current folder of a process, used when a session sends no usable folder header. */
  processCwd?: (pid: number) => Promise<string | undefined>;
  log?: (line: string) => void;
  /** Milliseconds a relayed server-to-client request may wait (elicitation waits for a person). */
  clientRequestTimeoutMs?: number;
  /** Largest request body accepted, in bytes (default 32 MiB; the SDK default is 4 MiB). */
  maxRequestBodyBytes?: number;
}

export const DEFAULT_MAX_REQUEST_BODY = 32 * 1024 * 1024;

/** List methods answered from the description cache. resources/list is not one of them. */
const LIST_METHODS: Record<string, { cap: string; key: keyof ServerDescription; field: string }> = {
  "tools/list": { cap: "tools", key: "tools", field: "tools" },
  "prompts/list": { cap: "prompts", key: "prompts", field: "prompts" },
  "resources/templates/list": { cap: "resources", key: "resourceTemplates", field: "resourceTemplates" },
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a valid bearer token lets the caller do. */
type Caller = { admin: true } | { admin: false; profile: string };

export const MASTER_TOKEN_REFUSED =
  "this agent config sends the master gateway token, which turno no longer accepts for MCP sessions (each profile has its own token now); run: turno mcp sync";
export const BAD_TOKEN = "bad token (after an upgrade or turno mcp token rotate, run: turno mcp sync)";

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/**
 * The session folder from the request headers. `X-Turno-Cwd-B64` (base64url of the UTF-8
 * path, set by the launchers) is preferred: raw non-Latin-1 paths cannot travel in an HTTP
 * header. The legacy `X-Turno-Cwd` is still read; a client that sent raw UTF-8 bytes arrives
 * as Latin-1 text, which is repaired here. Returns undefined unless the path is absolute.
 */
export function decodeCwdHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const pick = (name: string) => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const b64 = pick("x-turno-cwd-b64");
  if (b64 && /^[A-Za-z0-9_-]+={0,2}$/.test(b64)) {
    const path = Buffer.from(b64, "base64url").toString("utf8");
    if (isAbsolute(path) && !path.includes("�") && !path.includes("\0")) return path;
  }
  const raw = pick("x-turno-cwd");
  if (!raw || !isAbsolute(raw)) return undefined;
  if (/[\u0080-ÿ]/.test(raw)) {
    const repaired = Buffer.from(raw, "latin1").toString("utf8");
    if (!repaired.includes("�")) return repaired;
  }
  return raw;
}

/** listChanged on the lists mcpd can announce itself (it relists after every start). */
function announcedCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
  const out = { ...caps };
  for (const k of ["tools", "prompts", "resources"]) {
    const c = out[k];
    if (c && typeof c === "object") out[k] = { ...(c as Record<string, unknown>), listChanged: true };
  }
  return out;
}

/** One MCP client session against one server path. */
class ClientSession implements ClientHandle {
  id = "";
  lastSeen = Date.now();
  private nextId = 1;
  private waiting = new Map<Id, { resolve: (o: Outcome) => void; timer: NodeJS.Timeout }>();

  constructor(
    readonly ctx: ClientContext,
    readonly transport: StreamableHTTPServerTransport,
    private readonly gw: Gateway,
  ) {}

  supports(capability: string): boolean {
    const caps = this.ctx.clientCapabilities;
    return caps === undefined || caps[capability] !== undefined;
  }

  notify(method: string, params: Record<string, unknown> | undefined, related?: Id): void {
    const m: Message = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    void this.transport.send(m as never, related !== undefined ? { relatedRequestId: related } : undefined).catch(() => {});
  }

  request(method: string, params: Record<string, unknown> | undefined, related?: Id): Promise<Outcome> {
    const id = `s${this.nextId++}`;
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(rpcError(ErrorCode.Internal, `client did not answer ${method}`));
      }, this.gw.clientRequestTimeoutMs);
      this.waiting.set(id, { resolve, timer });
      const m: Message = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      this.transport.send(m as never, related !== undefined ? { relatedRequestId: related } : undefined).catch((err) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(rpcError(ErrorCode.Internal, `cannot reach client: ${(err as Error).message}`));
      });
    });
  }

  close(): void {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.resolve(rpcError(ErrorCode.Internal, "client session closed"));
    }
    this.waiting.clear();
  }

  onMessage(m: Message): void {
    this.lastSeen = Date.now();
    if (isResponse(m)) {
      const w = this.waiting.get(m.id as Id);
      if (w) {
        clearTimeout(w.timer);
        this.waiting.delete(m.id as Id);
        w.resolve(m.error ? { error: m.error } : { result: m.result ?? {} });
      }
      return;
    }
    if (isRequest(m)) {
      void this.handleRequest(m);
      return;
    }
    if (isNotification(m)) this.handleNotification(m);
  }

  private reply(id: Id, outcome: Outcome): void {
    void this.transport.send(toResponse(id, outcome) as never, { relatedRequestId: id }).catch(() => {});
  }

  private async handleRequest(m: Message): Promise<void> {
    const id = m.id as Id;
    const method = m.method as string;
    const manager = this.gw.manager;
    try {
      if (method === "initialize") {
        const init = m.params as { capabilities?: Record<string, unknown>; clientInfo?: { name?: unknown } } | undefined;
        this.ctx.clientCapabilities = init?.capabilities ?? {};
        const agent = cleanAgentName(init?.clientInfo?.name);
        if (agent) this.ctx.clientName = agent;
        const d = await manager.describe(this);
        this.reply(id, {
          result: {
            protocolVersion: negotiateVersion(m.params?.protocolVersion),
            capabilities: announcedCapabilities(d.capabilities),
            serverInfo: d.serverInfo,
            ...(d.instructions ? { instructions: d.instructions } : {}),
          },
        });
        return;
      }
      if (method === "ping") {
        this.reply(id, { result: {} });
        return;
      }
      const list = LIST_METHODS[method];
      if (list) {
        const d = await manager.describe(this);
        if (!d.capabilities[list.cap]) {
          this.reply(id, rpcError(ErrorCode.MethodNotFound, `${this.ctx.serverName} has no ${list.cap}`));
          return;
        }
        let items = (d[list.key] as unknown[] | undefined) ?? [];
        const filter = list.key === "tools" ? this.gw.toolFilter(this.ctx) : undefined;
        if (filter) items = items.filter((t) => toolAllowed(filter, String((t as { name?: unknown }).name ?? "")));
        this.reply(id, { result: { [list.field]: items } });
        return;
      }
      if (method === "tools/call") {
        const filter = this.gw.toolFilter(this.ctx);
        const tool = typeof m.params?.name === "string" ? m.params.name : "";
        if (filter && !toolAllowed(filter, tool)) {
          this.reply(id, rpcError(ErrorCode.InvalidParams, `tool ${tool} of ${this.ctx.serverName} is not available to profile ${this.ctx.profile ?? "default"} (tools.allow / tools.deny in mcp.toml)`));
          return;
        }
      }
      if (method === "logging/setLevel" && !manager.existing(this)) {
        this.reply(id, { result: {} });
        return;
      }
      if (method === "resources/subscribe" || method === "resources/unsubscribe") {
        const uri = typeof m.params?.uri === "string" ? m.params.uri : "";
        if (!uri) {
          this.reply(id, rpcError(ErrorCode.InvalidParams, `${method} needs a uri`));
          return;
        }
        this.reply(id, method === "resources/subscribe" ? await manager.subscribe(this, uri, id) : await manager.unsubscribe(this, uri, id));
        return;
      }
      this.reply(id, await manager.forward(this, method, m.params, id));
    } catch (err) {
      this.reply(id, rpcError(ErrorCode.Unavailable, `${this.ctx.serverName}: ${(err as Error).message}`));
    }
  }

  private handleNotification(m: Message): void {
    const method = m.method as string;
    if (method === "notifications/initialized") return;
    let inst: ReturnType<InstanceManager["existing"]>;
    try {
      inst = this.gw.manager.existing(this);
    } catch {
      return;
    }
    if (!inst) return;
    if (method === "notifications/roots/list_changed" && (scopeOf(inst.server) === "shared" || inst.workdirKnown)) return;
    inst.upstream.notify(method, m.params, this);
  }
}

/**
 * The HTTP face of mcpd: one Streamable HTTP endpoint per server (/mcp/<name>), bearer
 * token auth, localhost only, and per-session routing into the instance manager.
 */
export class Gateway {
  readonly manager: InstanceManager;
  readonly clientRequestTimeoutMs: number;
  private sessions = new Map<string, ClientSession>();
  private recreating = new Map<string, Promise<ClientSession | undefined>>();
  private http?: HttpServer;

  constructor(private readonly opts: GatewayOptions) {
    this.manager = opts.manager;
    this.manager.useManifest(opts.manifest);
    this.clientRequestTimeoutMs = opts.clientRequestTimeoutMs ?? 10 * 60_000;
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.log?.(`request failed: ${(err as Error).stack ?? err}`);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
      });
    });
    return new Promise((resolve, reject) => {
      this.http?.once("error", reject);
      this.http?.listen(port, host, () => {
        const addr = this.http?.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.close();
      await s.transport.close().catch(() => {});
    }
    this.sessions.clear();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.http?.closeAllConnections?.();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** Drop sessions whose client process is gone. */
  pruneSessions(isAlive: (pid: number) => boolean): void {
    for (const [id, s] of this.sessions) {
      if (s.ctx.pid && !isAlive(s.ctx.pid)) this.dropSession(id);
    }
  }

  private dropSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.close();
    this.manager.detach(s);
  }

  /** Local, not a browser, and a valid token: the master (admin) or a profile token. */
  private authenticate(req: IncomingMessage): Caller | { status: number; error: string } {
    const addr = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) return { status: 403, error: "not local" };
    const host = header(req, "host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return { status: 403, error: "bad host" };
    if (header(req, "origin") !== undefined) return { status: 403, error: "browser origin" };
    const auth = header(req, "authorization") ?? "";
    if (safeEqual(auth, `Bearer ${this.opts.token}`)) return { admin: true };
    const profile = auth.startsWith("Bearer ") ? tokenProfile(this.opts.token, auth.slice(7).trim()) : undefined;
    return profile ? { admin: false, profile } : { status: 401, error: BAD_TOKEN };
  }

  /** The tool filter for a session, or undefined when its server filters nothing. */
  toolFilter(ctx: ClientContext): ToolFilter | undefined {
    const server = this.opts.manifest().servers[ctx.serverName];
    if (!server) return undefined;
    const f = toolFilterFor(server, ctx.profile);
    return filtersTools(f) ? f : undefined;
  }

  private lastMasterWarning = 0;

  private refuseMaster(res: ServerResponse, name: string | undefined): void {
    if (Date.now() - this.lastMasterWarning > 60_000) {
      this.lastMasterWarning = Date.now();
      this.opts.log?.(`refused a session for ${name ?? "?"} that sent the master token: an agent config predates per-profile tokens (turno mcp sync fixes it)`);
    }
    json(res, 403, { error: MASTER_TOKEN_REFUSED });
  }

  private servable(name: string | undefined): boolean {
    const server = name ? this.opts.manifest().servers[name] : undefined;
    return server !== undefined && !(server.kind === "remote" && !server.proxy);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const caller = this.authenticate(req);
    if ("status" in caller) {
      json(res, caller.status, { error: caller.error });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const refresh = /^\/refresh(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if ((url.pathname === "/status" && req.method === "GET") || (refresh && req.method === "POST")) {
      if (!caller.admin) {
        json(res, 403, { error: "a profile token cannot use the admin endpoints" });
        return;
      }
      if (refresh) await this.handleRefresh(refresh[1] ? decodeURIComponent(refresh[1]) : undefined, res);
      else json(res, 200, this.status());
      return;
    }
    const m = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    const name = m?.[1] ? decodeURIComponent(m[1]) : undefined;
    if (caller.admin) {
      if (m) this.refuseMaster(res, name);
      else json(res, 404, { error: "unknown server " });
      return;
    }
    // The profile comes from the token; a header that disagrees is a config copied across
    // profiles or a forgery, and is refused rather than ignored.
    const claimed = header(req, "x-turno-profile")?.trim();
    if (claimed && claimed !== caller.profile) {
      json(res, 403, { error: `X-Turno-Profile says ${claimed}, but the token belongs to profile ${caller.profile}` });
      return;
    }
    const sid = header(req, "mcp-session-id");
    const open = sid ? this.sessions.get(sid) : undefined;
    // An open session goes on even if its server left the manifest: it then gets a JSON-RPC
    // error that says so, instead of an HTTP 404 the client reports as a transport failure.
    if (!name || (!this.servable(name) && open?.ctx.serverName !== name)) {
      json(res, 404, { error: `unknown server ${name ?? ""}` });
      return;
    }
    const def = this.opts.manifest().servers[name];
    if (def && !servesProfile(def, caller.profile)) {
      json(res, 403, { error: `server ${name} is not enabled for profile ${caller.profile} (profiles in mcp.toml)` });
      return;
    }
    if (open && open.ctx.profile !== caller.profile) {
      json(res, 403, { error: `session ${sid} belongs to another profile` });
      return;
    }
    if (sid) {
      let s = open;
      // mcpd restarted (upgrade, refresh, crash): rebuild the session under the same id from
      // the request headers instead of a 404 that ends the client's conversation.
      if (!s && (req.method === "POST" || req.method === "GET") && SESSION_ID.test(sid)) s = await this.recreate(req, name, sid, caller.profile);
      if (!s || s.ctx.serverName !== name || s.ctx.profile !== caller.profile) {
        json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      await s.transport.handleRequest(req, res);
      return;
    }
    const session = await this.createSession(req, name, caller.profile);
    await session?.transport.handleRequest(req, res);
    if (session && !session.transport.sessionId) await session.transport.close().catch(() => {});
  }

  /** `POST /refresh` (every server) or `POST /refresh/<server>`: relearn tool lists without a restart. */
  private async handleRefresh(name: string | undefined, res: ServerResponse): Promise<void> {
    const servers = this.opts.manifest().servers;
    if (name !== undefined && !servers[name]) {
      json(res, 404, { error: `unknown server ${name}` });
      return;
    }
    const names = name !== undefined ? [name] : Object.keys(servers).sort();
    const out: Record<string, unknown> = {};
    for (const n of names) out[n] = await this.manager.refresh(n);
    this.opts.log?.(`refreshed ${names.join(", ") || "nothing"}`);
    json(res, 200, name !== undefined ? { server: name, ...(out[name] as object) } : { servers: out });
  }

  /** Identity and folder of a new session: profile (from its token), PID (header, else TCP peer), folder (header, else the PID's). */
  private async sessionContext(req: IncomingMessage, name: string, profile: string): Promise<ClientContext> {
    let pid = Number.parseInt(header(req, "x-turno-pid") ?? "0", 10) || undefined;
    if (!pid && this.opts.peerPid && req.socket.remotePort) pid = await this.opts.peerPid(req.socket.remotePort);
    let cwd = decodeCwdHeaders(req.headers);
    if (cwd && !isDirectory(cwd)) {
      this.opts.log?.(`session folder ${cwd} for ${name} does not exist; looking at the client process instead`);
      cwd = undefined;
    }
    if (!cwd && pid) {
      const fromPid = await (this.opts.processCwd ?? processCwd)(pid);
      if (fromPid && isDirectory(fromPid)) cwd = fromPid;
    }
    const root = cwd ? await projectRoot(cwd) : undefined;
    return {
      serverName: name,
      sessionId: "",
      profile,
      ...(pid ? { pid } : {}),
      ...(cwd ? { cwd } : {}),
      ...(root ? { projectRoot: root } : {}),
    };
  }

  /** One recreation per id, even when the client's GET stream and next POST arrive together. */
  private recreate(req: IncomingMessage, name: string, sid: string, profile: string): Promise<ClientSession | undefined> {
    let p = this.recreating.get(sid);
    if (!p) {
      p = this.createSession(req, name, profile, sid);
      this.recreating.set(sid, p);
      p.finally(() => this.recreating.delete(sid)).catch(() => {});
    }
    return p;
  }

  private async createSession(req: IncomingMessage, name: string, profile: string, fixedId?: string): Promise<ClientSession | undefined> {
    const ctx = await this.sessionContext(req, name, profile);
    let session: ClientSession | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => fixedId ?? randomUUID(),
      maxRequestBodySize: this.opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY,
      onsessioninitialized: (id) => {
        if (!session) return;
        session.id = id;
        ctx.sessionId = id;
        this.sessions.set(id, session);
        this.manager.register(session);
      },
      onsessionclosed: (id) => this.dropSession(id),
    });
    session = new ClientSession(ctx, transport, this);
    const s = session;
    transport.onmessage = (msg) => s.onMessage(msg as unknown as Message);
    transport.onclose = () => {
      if (s.id) this.dropSession(s.id);
    };
    if (fixedId) {
      if (!markInitialized(transport, fixedId)) {
        await transport.close().catch(() => {});
        return undefined;
      }
      s.id = fixedId;
      ctx.sessionId = fixedId;
      this.sessions.set(fixedId, s);
      this.manager.register(s);
      this.opts.log?.(`recreated session ${fixedId} for ${name} (unknown to this mcpd, likely after a restart)`);
    }
    return s;
  }

  /** Agent processes behind the open sessions: one entry per client PID (or per session without one). */
  agents(): { pid: number | null; profile: string | null; agent: string | null; servers: string[] }[] {
    const by = new Map<string, { pid: number | null; profile: string | null; agent: string | null; servers: string[] }>();
    for (const s of this.sessions.values()) {
      const key = s.ctx.pid ? `pid:${s.ctx.pid}` : `sid:${s.id}`;
      const a = by.get(key) ?? { pid: s.ctx.pid ?? null, profile: s.ctx.profile ?? null, agent: s.ctx.clientName ?? null, servers: [] };
      if (!a.servers.includes(s.ctx.serverName)) a.servers.push(s.ctx.serverName);
      a.agent ??= s.ctx.clientName ?? null;
      by.set(key, a);
    }
    return [...by.values()];
  }

  status(): unknown {
    return {
      pid: process.pid,
      sessions: this.sessions.size,
      agents: this.agents(),
      instances: this.manager.list().map((i) => ({
        key: i.key,
        server: i.server.name,
        variant: i.variant,
        scope: i.scope,
        pid: i.upstream.pid ?? null,
        clients: i.clients.size,
        holder: i.holder ? { profile: i.holder.ctx.profile ?? null, pid: i.holder.ctx.pid ?? null } : null,
        idleSeconds: Math.round((Date.now() - i.upstream.lastActivity) / 1000),
        inflight: i.upstream.inflight,
        inflightByClient: i.upstream.inflightByClient(),
        startedAt: i.upstream.startedAt,
        restarts: this.manager.restarts(i.key),
      })),
    };
  }
}

/**
 * Put a fresh SDK transport in the state it has after initialize, under a known session id.
 * The SDK has no public way to adopt a session, so this sets two fields of its inner
 * web-standard transport; the SDK version is pinned and a test covers it. Returns false
 * (and the caller answers 404 as before) when the fields are not where they are expected.
 */
function markInitialized(transport: StreamableHTTPServerTransport, id: string): boolean {
  const inner = (transport as unknown as { _webStandardTransport?: Record<string, unknown> })._webStandardTransport;
  if (!inner || typeof inner._initialized !== "boolean") return false;
  inner.sessionId = id;
  inner._initialized = true;
  return true;
}
