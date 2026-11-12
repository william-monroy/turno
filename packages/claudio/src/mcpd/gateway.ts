import { randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { Manifest, ServerDef } from "../core/manifest.js";
import type { ServerDescription } from "./cache.js";
import { type ClientContext, type ClientHandle, type InstanceManager, scopeOf } from "./instances.js";
import { ErrorCode, type Id, type Message, type Outcome, isNotification, isRequest, isResponse, rpcError, toResponse } from "./jsonrpc.js";

export interface GatewayOptions {
  manager: InstanceManager;
  manifest: () => Manifest;
  token: string;
  /** Finds the PID of a local TCP peer (lsof) when the session did not send one. */
  peerPid?: (remotePort: number) => Promise<number | undefined>;
  log?: (line: string) => void;
  /** Milliseconds a relayed server-to-client request may wait (elicitation waits for a person). */
  clientRequestTimeoutMs?: number;
}

const LIST_METHODS: Record<string, { cap: string; key: keyof ServerDescription; field: string }> = {
  "tools/list": { cap: "tools", key: "tools", field: "tools" },
  "prompts/list": { cap: "prompts", key: "prompts", field: "prompts" },
  "resources/list": { cap: "resources", key: "resources", field: "resources" },
  "resources/templates/list": { cap: "resources", key: "resourceTemplates", field: "resourceTemplates" },
};

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

/** One Claude Code MCP session against one server path. */
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
        const d = await manager.describe(this);
        this.reply(id, {
          result: {
            protocolVersion: negotiateVersion(m.params?.protocolVersion),
            capabilities: d.capabilities,
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
          this.reply(id, rpcError(ErrorCode.MethodNotFound, `${this.ctx.server.name} has no ${list.cap}`));
          return;
        }
        this.reply(id, { result: { [list.field]: d[list.key] ?? [] } });
        return;
      }
      if (method === "logging/setLevel" && !manager.existing(this)) {
        this.reply(id, { result: {} });
        return;
      }
      const inst = await manager.acquire(this);
      if ("error" in inst || "result" in inst) {
        this.reply(id, inst as Outcome);
        return;
      }
      this.reply(id, await inst.upstream.call(method, m.params, this, id));
    } catch (err) {
      this.reply(id, rpcError(ErrorCode.Unavailable, `${this.ctx.server.name}: ${(err as Error).message}`));
    }
  }

  private handleNotification(m: Message): void {
    const method = m.method as string;
    if (method === "notifications/initialized") return;
    const inst = this.gw.manager.existing(this);
    if (!inst) return;
    if (method === "notifications/roots/list_changed" && scopeOf(this.ctx.server) === "shared") return;
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
  private http?: HttpServer;

  constructor(private readonly opts: GatewayOptions) {
    this.manager = opts.manager;
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

  /** Drop sessions whose Claude Code process is gone. */
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

  private authorized(req: IncomingMessage): string | undefined {
    const addr = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) return "not local";
    const host = header(req, "host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return "bad host";
    if (header(req, "origin") !== undefined) return "browser origin";
    const auth = header(req, "authorization") ?? "";
    if (!safeEqual(auth, `Bearer ${this.opts.token}`)) return "bad token";
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const denied = this.authorized(req);
    if (denied) {
      json(res, denied === "bad token" ? 401 : 403, { error: denied });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/status" && req.method === "GET") {
      json(res, 200, this.status());
      return;
    }
    const m = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    const name = m?.[1] ? decodeURIComponent(m[1]) : undefined;
    const server: ServerDef | undefined = name ? this.opts.manifest().servers[name] : undefined;
    if (!server || (server.kind === "remote" && !server.proxy)) {
      json(res, 404, { error: `unknown server ${name ?? ""}` });
      return;
    }
    const sid = header(req, "mcp-session-id");
    if (sid) {
      const s = this.sessions.get(sid);
      if (!s || s.ctx.server.name !== server.name) {
        json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      await s.transport.handleRequest(req, res);
      return;
    }
    // New session: identity comes from headers; PID falls back to the TCP peer.
    const profile = header(req, "x-claudio-profile") || undefined;
    let pid = Number.parseInt(header(req, "x-claudio-pid") ?? "0", 10) || undefined;
    if (!pid && this.opts.peerPid && req.socket.remotePort) pid = await this.opts.peerPid(req.socket.remotePort);
    const cwd = header(req, "x-claudio-cwd") || undefined;
    const ctx: ClientContext = {
      server,
      sessionId: "",
      ...(profile ? { profile } : {}),
      ...(pid ? { pid } : {}),
      ...(cwd ? { cwd } : {}),
    };
    let session: ClientSession | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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
    await transport.handleRequest(req, res);
    if (!transport.sessionId) await transport.close().catch(() => {});
  }

  status(): unknown {
    return {
      pid: process.pid,
      sessions: this.sessions.size,
      instances: this.manager.list().map((i) => ({
        key: i.key,
        server: i.server.name,
        variant: i.variant,
        pid: i.upstream.pid ?? null,
        clients: i.clients.size,
        holder: i.holder ? { profile: i.holder.ctx.profile ?? null, pid: i.holder.ctx.pid ?? null } : null,
        idleSeconds: Math.round((Date.now() - i.upstream.lastActivity) / 1000),
        inflight: i.upstream.inflight,
        startedAt: i.upstream.startedAt,
      })),
    };
  }
}
