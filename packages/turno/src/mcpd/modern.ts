import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { type ToolFilter, toolAllowed } from "../core/manifest.js";
import type { ServerDescription } from "./cache.js";
import { cleanAgentName } from "./calllog.js";
import type { ClientContext, ClientHandle, InstanceManager } from "./instances.js";
import { ErrorCode, type Id, type Message, type Outcome, rpcError } from "./jsonrpc.js";

/**
 * MCP revision 2026-07-28 on mcpd's HTTP endpoint (ADR 0028): stateless requests that carry
 * their protocol version, client capabilities and identity in `_meta`, with no `initialize` and
 * no `Mcp-Session-Id`. 2025-11-25 sessions keep going through the SDK transport in gateway.ts;
 * the upstream servers are still spoken to as 2025-11-25 clients.
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION];
/** What `server/discover` and UnsupportedProtocolVersion list: modern first, then every legacy one. */
export const ALL_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS];

/** Freshness hint for lists checked against a running server since mcpd started. */
export const LIST_TTL_MS = 5 * 60_000;
/** A stateless client with nothing in flight is forgotten after this long without requests. */
export const STATELESS_IDLE_MS = 30 * 60_000;
/** SSE comment sent on quiet `subscriptions/listen` streams. */
export const KEEPALIVE_MS = 25_000;

export const ModernErrorCode = {
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

const PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const LOG_LEVEL = "io.modelcontextprotocol/logLevel";
const SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** List methods answered from the description cache, as in gateway.ts. */
const LISTS: Record<string, { cap: string; key: keyof ServerDescription; field: string }> = {
  "tools/list": { cap: "tools", key: "tools", field: "tools" },
  "prompts/list": { cap: "prompts", key: "prompts", field: "prompts" },
  "resources/templates/list": { cap: "resources", key: "resourceTemplates", field: "resourceTemplates" },
};

/** Methods whose request carries `Mcp-Name`, and the body field it mirrors. */
const NAMED: Record<string, "name" | "uri"> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

/** 2025-11-25 methods that 2026-07-28 removed; they lean on session state mcpd does not keep for these clients. */
const REMOVED = new Set(["initialize", "ping", "logging/setLevel", "resources/subscribe", "resources/unsubscribe"]);

/** Results mcpd relays without caching; the revision requires caching hints on them. */
const UNCACHED = new Set(["resources/list", "resources/read"]);

/** Server-to-client requests: a 2026-07-28 client only answers them through MRTR, which mcpd does not bridge yet. */
const SERVER_REQUESTS = new Set(["elicitation", "sampling", "roots"]);

const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Whether a POST goes the stateless way: its MCP-Protocol-Version is not a 2025-era one. A
 * 2026-07-28 request is stateless even with an `Mcp-Session-Id`, which that revision says to
 * ignore; an unknown version with a session id stays with the session (the SDK refuses it).
 */
export function wantsModern(req: IncomingMessage): boolean {
  if (req.method !== "POST") return false;
  const v = header(req, "mcp-protocol-version")?.trim();
  if (v === undefined || v === "" || SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return false;
  return header(req, "mcp-session-id") === undefined || MODERN_PROTOCOL_VERSIONS.includes(v);
}

/** Whether a parsed body is an initialize request (a dual-era client asking for a 2025-era session). */
export function isInitialize(body: unknown): boolean {
  return isObject(body) && body.method === "initialize" && body.id !== undefined && body.id !== null;
}

/** Read and parse a JSON body, refusing more than `limit` bytes. */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<{ value: unknown } | { status: number; code: number; message: string }> {
  return new Promise((resolve) => {
    const declared = Number(header(req, "content-length") ?? "0");
    if (declared > limit) {
      resolve({ status: 413, code: ErrorCode.InvalidRequest, message: `request body larger than ${limit} bytes` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        resolve({ status: 413, code: ErrorCode.InvalidRequest, message: `request body larger than ${limit} bytes` });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ status: 400, code: ErrorCode.ParseError, message: "Parse error: the body is not JSON" });
      }
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      resolve({ status: 400, code: ErrorCode.InvalidRequest, message: err.message });
    });
  });
}

/** Decode the `=?base64?...?=` sentinel of Mcp-Name and Mcp-Param-* values; undefined when it is not valid Base64. */
export function decodeHeaderValue(v: string): string | undefined {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  const b64 = m[1] ?? "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return undefined;
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Every `x-mcp-header` reachable from the schema root through `properties` keys only, with its path. */
function annotatedParams(schema: unknown, path: string[] = [], out: { name: string; path: string[]; type: unknown }[] = []) {
  if (!isObject(schema) || !isObject(schema.properties)) return out;
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (!isObject(sub)) continue;
    const name = sub["x-mcp-header"];
    if (typeof name === "string" && name) out.push({ name, path: [...path, key], type: sub.type });
    annotatedParams(sub, [...path, key], out);
  }
  return out;
}

function valueAt(args: unknown, path: string[]): unknown {
  let v: unknown = args;
  for (const k of path) v = isObject(v) ? v[k] : undefined;
  return v;
}

/**
 * Check the `Mcp-Param-{Name}` headers of a tools/call against its arguments, for the tool's
 * `x-mcp-header` annotations. Returns the problem, or undefined when they agree.
 */
export function paramHeaderProblem(tool: unknown, args: unknown, headers: Record<string, string | string[] | undefined>): string | undefined {
  const schema = isObject(tool) ? tool.inputSchema : undefined;
  for (const p of annotatedParams(schema)) {
    const hname = `mcp-param-${p.name.toLowerCase()}`;
    const raw = headers[hname];
    const sent = Array.isArray(raw) ? raw[0] : raw;
    const value = valueAt(args, p.path);
    if (value === undefined || value === null) {
      if (sent !== undefined) return `Mcp-Param-${p.name} was sent, but ${p.path.join(".")} is not in the arguments`;
      continue;
    }
    if (sent === undefined) return `missing Mcp-Param-${p.name} for ${p.path.join(".")}`;
    const decoded = decodeHeaderValue(sent);
    if (decoded === undefined) return `Mcp-Param-${p.name} is not valid Base64`;
    const agrees =
      typeof value === "number"
        ? decoded.trim() !== "" && Number(decoded) === value
        : typeof value === "boolean"
          ? decoded === String(value)
          : decoded === String(value);
    if (!agrees) return `Mcp-Param-${p.name} header value does not match the body value of ${p.path.join(".")}`;
  }
  return undefined;
}

/**
 * Error codes for a 2026-07-28 client. The revision forbids -32002 (resource not found is now
 * -32602) and -32042 (URL elicitation, 2025-11-25 only); mcpd's own -32002 ("server
 * unavailable") becomes Internal error.
 */
export function modernErrorCode(code: number, method: string): number {
  if (code === -32002) return method === "resources/read" ? ErrorCode.InvalidParams : ErrorCode.Internal;
  if (code === -32042) return ErrorCode.Internal;
  return code;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function openSse(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();
}

function writeSse(res: ServerResponse, m: Message): void {
  if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
}

function errorBody(id: Id | null, code: number, message: string, data?: unknown): Json {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** One HTTP request in flight: where its request-scoped notifications go. */
interface Call {
  res: ServerResponse;
  stream: boolean;
  logLevel?: string;
}

/** One `subscriptions/listen` stream. */
class Listener {
  private ready = false;
  private queue: [string, Json | undefined][] = [];
  timer?: NodeJS.Timeout;

  constructor(
    readonly res: ServerResponse,
    readonly id: Id,
    readonly filter: { toolsListChanged?: true; promptsListChanged?: true; resourcesListChanged?: true; resourceSubscriptions?: string[] },
  ) {}

  wants(method: string, params: Json | undefined): boolean {
    switch (method) {
      case "notifications/tools/list_changed":
        return Boolean(this.filter.toolsListChanged);
      case "notifications/prompts/list_changed":
        return Boolean(this.filter.promptsListChanged);
      case "notifications/resources/list_changed":
        return Boolean(this.filter.resourcesListChanged);
      case "notifications/resources/updated":
        return typeof params?.uri === "string" && (this.filter.resourceSubscriptions ?? []).includes(params.uri);
      default:
        return false;
    }
  }

  deliver(method: string, params: Json | undefined): void {
    if (!this.wants(method, params)) return;
    if (!this.ready) {
      this.queue.push([method, params]);
      return;
    }
    const meta = isObject(params?._meta) ? params._meta : {};
    writeSse(this.res, { jsonrpc: "2.0", method, params: { ...(params ?? {}), _meta: { ...meta, [SUBSCRIPTION_ID]: this.id } } });
  }

  /** Send the acknowledgment, then whatever arrived while the subscription was being set up. */
  acknowledge(): void {
    writeSse(this.res, {
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUBSCRIPTION_ID]: this.id }, notifications: this.filter },
    });
    this.ready = true;
    for (const [m, p] of this.queue.splice(0)) this.deliver(m, p);
  }

  /** Graceful end: the response to the listen request, then close (mcpd is stopping). */
  end(): void {
    if (this.timer) clearInterval(this.timer);
    writeSse(this.res, { jsonrpc: "2.0", id: this.id, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID]: this.id } } });
    if (!this.res.writableEnded) this.res.end();
  }
}

/**
 * The agent behind stateless requests: one per profile, server, client PID and folder, so an
 * exclusive lease, a session-scoped instance and the call log see the same client across its
 * requests, as they would see a 2025-11-25 session.
 */
export class StatelessClient implements ClientHandle {
  readonly id: string;
  lastSeen = Date.now();
  readonly calls = new Map<Id, Call>();
  readonly listeners = new Set<Listener>();

  constructor(readonly ctx: ClientContext) {
    this.id = ctx.sessionId;
  }

  get listening(): boolean {
    for (const l of this.listeners) if (l.filter.resourcesListChanged) return true;
    return false;
  }

  supports(capability: string): boolean {
    return !SERVER_REQUESTS.has(capability);
  }

  /** Request-scoped notifications go to that request's stream; the rest to the listen streams. */
  notify(method: string, params: Record<string, unknown> | undefined, related?: Id): void {
    if (related === undefined) {
      for (const l of this.listeners) l.deliver(method, params);
      return;
    }
    const call = this.calls.get(related);
    if (!call?.stream) return;
    if (method === "notifications/progress") {
      writeSse(call.res, { jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      return;
    }
    // The revision: no notifications/message for a request that did not ask for a log level.
    if (method === "notifications/message" && call.logLevel) {
      const level = LOG_LEVELS.indexOf(String(params?.level ?? ""));
      if (level >= LOG_LEVELS.indexOf(call.logLevel)) writeSse(call.res, { jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    }
  }

  request(method: string): Promise<Outcome> {
    return Promise.resolve(
      rpcError(
        ErrorCode.MethodNotFound,
        `${this.ctx.serverName} sent ${method}, but the agent speaks MCP ${MODERN_PROTOCOL_VERSION}, and turno does not relay server requests to it yet`,
      ),
    );
  }
}

export interface FrontOptions {
  manager: InstanceManager;
  toolFilter: (ctx: ClientContext) => ToolFilter | undefined;
  /** Identity and folder of a new client (the gateway's session context). */
  context: (req: IncomingMessage, name: string, profile: string) => Promise<ClientContext>;
  /** Capabilities as mcpd announces them (listChanged on lists it can relist). */
  capabilities: (caps: Record<string, unknown>) => Record<string, unknown>;
  peerPid?: (remotePort: number) => Promise<number | undefined>;
  log?: (line: string) => void;
}

/** Serves 2026-07-28 requests for the gateway. */
export class StatelessFront {
  private clients = new Map<string, StatelessClient>();
  private creating = new Map<string, Promise<StatelessClient>>();
  private peers = new WeakMap<Socket, Promise<number | undefined>>();
  private seq = 0;

  constructor(private readonly opts: FrontOptions) {}

  list(): StatelessClient[] {
    return [...this.clients.values()];
  }

  /** Forget clients whose process exited or that went quiet; their leases and subscriptions go with them. */
  prune(isAlive: (pid: number) => boolean, now = Date.now()): void {
    for (const [key, c] of this.clients) {
      const dead = c.ctx.pid !== undefined && !isAlive(c.ctx.pid);
      const quiet = c.calls.size === 0 && c.listeners.size === 0 && now - c.lastSeen > STATELESS_IDLE_MS;
      if (!dead && !quiet) continue;
      this.clients.delete(key);
      for (const l of c.listeners) l.end();
      c.listeners.clear();
      this.opts.manager.detach(c);
    }
  }

  /** mcpd is stopping: end every listen stream gracefully. */
  close(): void {
    for (const c of this.clients.values()) {
      for (const l of c.listeners) l.end();
      c.listeners.clear();
    }
  }

  private pidOf(req: IncomingMessage): Promise<number | undefined> {
    const h = Number.parseInt(header(req, "x-turno-pid") ?? "", 10);
    if (h > 0) return Promise.resolve(h);
    const socket = req.socket;
    if (!this.opts.peerPid || !socket.remotePort) return Promise.resolve(undefined);
    let p = this.peers.get(socket);
    if (!p) {
      p = this.opts.peerPid(socket.remotePort).catch(() => undefined);
      this.peers.set(socket, p);
    }
    return p;
  }

  private async client(req: IncomingMessage, name: string, profile: string): Promise<StatelessClient> {
    const pid = await this.pidOf(req);
    const folder = header(req, "x-turno-cwd-b64") ?? header(req, "x-turno-cwd") ?? "";
    const key = JSON.stringify([profile, name, pid ?? null, folder]);
    const known = this.clients.get(key);
    if (known) return known;
    let p = this.creating.get(key);
    if (!p) {
      p = (async () => {
        const ctx = await this.opts.context(req, name, profile);
        if (pid && !ctx.pid) ctx.pid = pid;
        ctx.sessionId = `stateless-${++this.seq}`;
        const c = new StatelessClient(ctx);
        this.clients.set(key, c);
        this.opts.manager.register(c);
        return c;
      })();
      this.creating.set(key, p);
      p.finally(() => this.creating.delete(key)).catch(() => {});
    }
    return p;
  }

  /** Answer one 2026-07-28 POST whose body is already parsed. */
  async handle(req: IncomingMessage, res: ServerResponse, name: string, profile: string, body: unknown): Promise<void> {
    if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      sendJson(res, 400, errorBody(null, ErrorCode.InvalidRequest, "Invalid Request: the body must be one JSON-RPC request or notification"));
      return;
    }
    const method = body.method;
    const hasId = body.id !== undefined && body.id !== null;
    if (!hasId) {
      // No client notification is defined over HTTP in this revision (cancellation is closing the stream).
      res.writeHead(202).end();
      return;
    }
    if (typeof body.id !== "string" && typeof body.id !== "number") {
      sendJson(res, 400, errorBody(null, ErrorCode.InvalidRequest, "Invalid Request: the id must be a string or a number"));
      return;
    }
    const id = body.id;
    const version = header(req, "mcp-protocol-version")?.trim() ?? "";
    if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
      sendJson(res, 400, errorBody(id, ModernErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", { supported: ALL_PROTOCOL_VERSIONS, requested: version }));
      return;
    }
    const params = isObject(body.params) ? body.params : {};
    const mismatch = (message: string) => sendJson(res, 400, errorBody(id, ModernErrorCode.HeaderMismatch, `Header mismatch: ${message}`));
    const mcpMethod = header(req, "mcp-method");
    if (mcpMethod === undefined) return mismatch("missing Mcp-Method header");
    if (mcpMethod !== method) return mismatch(`Mcp-Method header value '${mcpMethod}' does not match body value '${method}'`);
    const field = NAMED[method];
    if (field) {
      const sent = header(req, "mcp-name");
      if (sent === undefined) return mismatch(`missing Mcp-Name header for ${method}`);
      const decoded = decodeHeaderValue(sent);
      if (decoded === undefined || decoded !== params[field]) return mismatch(`Mcp-Name header value does not match body value of params.${field}`);
    }
    const meta = isObject(params._meta) ? params._meta : {};
    for (const k of [PROTOCOL_VERSION, CLIENT_CAPABILITIES]) {
      const ok = k === PROTOCOL_VERSION ? typeof meta[k] === "string" : isObject(meta[k]);
      if (!ok) {
        sendJson(res, 400, errorBody(id, ErrorCode.InvalidParams, `Invalid params: _meta["${k}"] is required`));
        return;
      }
    }
    if (meta[PROTOCOL_VERSION] !== version) return mismatch(`MCP-Protocol-Version header value '${version}' does not match _meta value '${String(meta[PROTOCOL_VERSION])}'`);
    if (REMOVED.has(method)) {
      sendJson(res, 404, errorBody(id, ErrorCode.MethodNotFound, `Method not found: ${method} is not part of MCP ${version}`));
      return;
    }

    const client = await this.client(req, name, profile);
    client.lastSeen = Date.now();
    const caps = meta[CLIENT_CAPABILITIES] as Json;
    // Capabilities mcpd cannot honor for this client are not passed on to the server.
    client.ctx.clientCapabilities = Object.fromEntries(Object.entries(caps).filter(([k]) => !SERVER_REQUESTS.has(k)));
    const agent = cleanAgentName(isObject(meta[CLIENT_INFO]) ? meta[CLIENT_INFO].name : undefined);
    if (agent) client.ctx.clientName = agent;

    try {
      if (method === "server/discover") return await this.discover(res, id, client);
      if (LISTS[method]) return await this.answerList(res, id, method, client);
      if (method === "subscriptions/listen") return await this.listen(req, res, id, params, client);
      return await this.forward(req, res, id, method, params, meta, client);
    } catch (err) {
      this.reply(res, id, method, rpcError(ErrorCode.Internal, `${name}: ${(err as Error).message}`));
    }
  }

  /** ttlMs for a cached description: trusted only once a running server confirmed it. */
  private ttl(d: ServerDescription): number {
    return this.opts.manager.verified(d) ? LIST_TTL_MS : 0;
  }

  private stamp(result: Json, serverInfo: unknown): Json {
    const meta = isObject(result._meta) ? result._meta : {};
    return { ...result, resultType: typeof result.resultType === "string" ? result.resultType : "complete", ...(serverInfo ? { _meta: { ...meta, [SERVER_INFO]: serverInfo } } : {}) };
  }

  private reply(res: ServerResponse, id: Id, method: string, outcome: Outcome, serverInfo?: unknown): void {
    let msg: Json;
    let status = 200;
    if ("error" in outcome) {
      const code = modernErrorCode(outcome.error.code, method);
      if (code === ErrorCode.MethodNotFound) status = 404;
      msg = { jsonrpc: "2.0", id, error: { ...outcome.error, code } };
    } else {
      let result = this.stamp(outcome.result, serverInfo);
      if (UNCACHED.has(method)) result = { ...result, ttlMs: 0, cacheScope: "private" };
      msg = { jsonrpc: "2.0", id, result };
    }
    if (res.headersSent) {
      writeSse(res, msg as unknown as Message);
      if (!res.writableEnded) res.end();
      return;
    }
    sendJson(res, status, msg);
  }

  private async discover(res: ServerResponse, id: Id, client: StatelessClient): Promise<void> {
    const d = await this.opts.manager.describe(client);
    // 2025-11-25 tasks are an extension in 2026-07-28, which mcpd does not offer.
    const { tasks: _tasks, ...caps } = this.opts.capabilities(d.capabilities);
    const result: Json = {
      supportedVersions: ALL_PROTOCOL_VERSIONS,
      capabilities: caps,
      ...(d.instructions ? { instructions: d.instructions } : {}),
      ttlMs: this.ttl(d),
      cacheScope: "private",
    };
    this.reply(res, id, "server/discover", { result }, d.serverInfo);
  }

  private async answerList(res: ServerResponse, id: Id, method: string, client: StatelessClient): Promise<void> {
    const spec = LISTS[method]!;
    const d = await this.opts.manager.describe(client);
    if (!d.capabilities[spec.cap]) {
      this.reply(res, id, method, rpcError(ErrorCode.MethodNotFound, `${client.ctx.serverName} has no ${spec.cap}`));
      return;
    }
    let items = (d[spec.key] as unknown[] | undefined) ?? [];
    const filter = spec.key === "tools" ? this.opts.toolFilter(client.ctx) : undefined;
    if (filter) items = items.filter((t) => toolAllowed(filter, String((t as { name?: unknown }).name ?? "")));
    // Private: lists differ by profile (variants, tool filters), and the profile token is the authorization context.
    this.reply(res, id, method, { result: { [spec.field]: items, ttlMs: this.ttl(d), cacheScope: "private" } }, d.serverInfo);
  }

  private async forward(req: IncomingMessage, res: ServerResponse, id: Id, method: string, params: Json, meta: Json, client: StatelessClient): Promise<void> {
    const manager = this.opts.manager;
    if (method === "tools/call") {
      const tool = typeof params.name === "string" ? params.name : "";
      const filter = this.opts.toolFilter(client.ctx);
      if (filter && !toolAllowed(filter, tool)) {
        this.reply(res, id, method, rpcError(ErrorCode.InvalidParams, `tool ${tool} of ${client.ctx.serverName} is not available to profile ${client.ctx.profile ?? "default"} (tools.allow / tools.deny in mcp.toml)`));
        return;
      }
      const d = await manager.describe(client);
      const def = (d.tools ?? []).find((t) => isObject(t) && t.name === tool);
      const problem = def ? paramHeaderProblem(def, params.arguments, req.headers) : undefined;
      if (problem) {
        sendJson(res, 400, errorBody(id, ModernErrorCode.HeaderMismatch, `Header mismatch: ${problem}`));
        return;
      }
    }
    // The upstream speaks 2025-11-25: the per-request protocol fields stay here.
    const upMeta = Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith("io.modelcontextprotocol/")));
    const { _meta: _drop, ...rest } = params;
    const upParams: Json = { ...rest, ...(Object.keys(upMeta).length ? { _meta: upMeta } : {}) };
    const logLevel = typeof meta[LOG_LEVEL] === "string" && LOG_LEVELS.includes(meta[LOG_LEVEL] as string) ? (meta[LOG_LEVEL] as string) : undefined;
    const call: Call = { res, stream: meta.progressToken !== undefined || logLevel !== undefined, ...(logLevel ? { logLevel } : {}) };
    // Our own id for the call, so two requests of one client never collide upstream.
    const internal = `h${++this.seq}`;
    client.calls.set(internal, call);
    if (call.stream) openSse(res);
    let settled = false;
    res.on("close", () => {
      if (settled) return;
      // Closing the response is the cancellation signal in this revision.
      try {
        manager.existing(client)?.upstream.notify("notifications/cancelled", { requestId: internal, reason: "the client closed the request" }, client);
      } catch {
        /* the server left the manifest; nothing to cancel */
      }
    });
    let outcome: Outcome;
    try {
      outcome = await manager.forward(client, method, upParams, internal);
    } finally {
      settled = true;
      client.calls.delete(internal);
      client.lastSeen = Date.now();
    }
    if (res.destroyed || res.writableEnded) return;
    this.reply(res, id, method, outcome, manager.cachedDescription(client)?.serverInfo);
  }

  private async listen(req: IncomingMessage, res: ServerResponse, id: Id, params: Json, client: StatelessClient): Promise<void> {
    const manager = this.opts.manager;
    const asked = isObject(params.notifications) ? params.notifications : {};
    const d = await manager.describe(client);
    const caps = d.capabilities;
    const filter: Listener["filter"] = {};
    if (asked.toolsListChanged === true && caps.tools) filter.toolsListChanged = true;
    if (asked.promptsListChanged === true && caps.prompts) filter.promptsListChanged = true;
    if (asked.resourcesListChanged === true && caps.resources) filter.resourcesListChanged = true;
    const uris = Array.isArray(asked.resourceSubscriptions) ? asked.resourceSubscriptions.filter((u): u is string => typeof u === "string" && u !== "") : [];
    const listener = new Listener(res, id, filter);
    openSse(res);
    client.listeners.add(listener);
    let open = true;
    const subscribed: string[] = [];
    // Drop upstream subscriptions no other stream of this client still wants.
    const release = (list: string[]) => {
      for (const uri of list) {
        if ([...client.listeners].some((l) => l.filter.resourceSubscriptions?.includes(uri))) continue;
        void manager.unsubscribe(client, uri, `h${++this.seq}`).catch(() => {});
      }
    };
    res.on("close", () => {
      open = false;
      if (listener.timer) clearInterval(listener.timer);
      client.listeners.delete(listener);
      release([...subscribed]);
    });
    const subscribes = isObject(caps.resources) && caps.resources.subscribe === true;
    if (uris.length && subscribes) {
      for (const uri of uris) {
        const out = await manager.subscribe(client, uri, `h${++this.seq}`);
        if ("error" in out) this.opts.log?.(`${client.ctx.serverName}: subscriptions/listen could not subscribe to a resource: ${out.error.message}`);
        else if (!open) release([uri]);
        else subscribed.push(uri);
      }
      if (subscribed.length) filter.resourceSubscriptions = [...subscribed];
    }
    if (!open) return;
    listener.acknowledge();
    listener.timer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
    }, KEEPALIVE_MS);
    listener.timer.unref();
  }
}
