import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type Id, type Message, type Outcome, isNotification, isRequest, isResponse, rpcError } from "./jsonrpc.js";

/** The client side an upstream talks back to: one MCP client session. */
export interface ClientPort {
  readonly id: string;
  /** Send a notification to the client, on the stream of `related` when given. */
  notify(method: string, params: Record<string, unknown> | undefined, related?: Id): void;
  /** Relay a server-to-client request (roots, elicitation, sampling) and wait for the answer. */
  request(method: string, params: Record<string, unknown> | undefined, related?: Id): Promise<Outcome>;
  /** Whether the client declared a capability (true when its capabilities are unknown). */
  supports?(capability: string): boolean;
}

interface Pending {
  resolve: (o: Outcome) => void;
  method: string;
  origin?: ClientPort;
  originId?: Id;
  timer?: NodeJS.Timeout;
}

export interface InitResult {
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface UpstreamOptions {
  label: string;
  /** Creates the transport (not started). */
  connect: () => Promise<Transport>;
  /** Notifications that are not tied to a request (list_changed, resources/updated, server logs). */
  onBroadcast?: (method: string, params: Record<string, unknown> | undefined) => void;
  onClose?: (reason: string) => void;
  /** Milliseconds to wait for initialize. */
  initTimeoutMs?: number;
  pid?: () => number | null | undefined;
  /**
   * Client capabilities mcpd declares to the server. Defaults to roots and form elicitation;
   * the instance manager narrows them to what the clients behind it support.
   */
  capabilities?: Record<string, unknown>;
  /** Answer roots/list inside mcpd (the instance folder); undefined means ask a client. */
  localRoots?: () => Record<string, unknown> | undefined;
  /** Clients attached to the instance, used to route a server request when no call is in flight. */
  attached?: () => ClientPort[];
  /** Diagnostics (routing refusals). */
  log?: (line: string) => void;
}

/** Server-to-client requests and the client capability each needs. */
const CLIENT_CAPABILITY: Record<string, string> = {
  "elicitation/create": "elicitation",
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
};

/** Server notifications that belong to one call and are routed like server requests. */
const ROUTED_NOTIFICATIONS = new Set(["notifications/message", "notifications/elicitation/complete"]);

type Route = { origin: ClientPort; originId?: Id } | { error: string; code: number };

/** True for the error the SDK raises when a remote server no longer knows our session. */
function sessionGone(err: unknown, hadSession: boolean): boolean {
  const code = (err as { code?: unknown }).code;
  return hadSession && code === 404;
}

/**
 * One running MCP server, spoken to over a raw transport. Request ids and progress tokens
 * are rewritten so several clients can share it without their messages crossing. Every
 * request it relays is settled exactly once: by the server's answer, a cancellation, a
 * timeout, the client going away, or the server stopping (ADR 0016).
 */
export class Upstream {
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private progress = new Map<string, { origin: ClientPort; token: unknown; originId?: Id }>();
  private closed = false;
  init?: InitResult;
  lastActivity = Date.now();
  startedAt = Date.now();
  /** A remote server answered 404 to our session: the instance must be replaced. */
  sessionLost = false;

  constructor(private readonly opts: UpstreamOptions) {}

  get label(): string {
    return this.opts.label;
  }

  get pid(): number | undefined {
    return this.opts.pid?.() ?? undefined;
  }

  get inflight(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Calls in flight on behalf of one client. */
  inflightFor(client: ClientPort): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.origin === client) n++;
    return n;
  }

  /** Calls in flight per client session id, for /status. */
  inflightByClient(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.pending.values()) if (p.origin) out[p.origin.id] = (out[p.origin.id] ?? 0) + 1;
    return out;
  }

  async start(): Promise<InitResult> {
    const t = await this.opts.connect();
    this.transport = t;
    t.onmessage = (m) => this.onMessage(m as unknown as Message);
    t.onclose = () => this.handleClose("transport closed");
    t.onerror = () => {
      /* errors surface as failed requests or close */
    };
    await t.start();
    const res = await this.call(
      "initialize",
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: this.opts.capabilities ?? { roots: { listChanged: true }, elicitation: { form: {} } },
        clientInfo: { name: "turno-mcpd", version: "0.1.0" },
      },
      undefined,
      undefined,
      this.opts.initTimeoutMs ?? 60_000,
    );
    if ("error" in res) {
      await this.close();
      throw new Error(`${this.label}: initialize failed: ${res.error.message}`);
    }
    const r = res.result;
    this.init = {
      protocolVersion: String(r.protocolVersion ?? LATEST_PROTOCOL_VERSION),
      serverInfo: (r.serverInfo as Record<string, unknown>) ?? { name: this.label, version: "0" },
      capabilities: (r.capabilities as Record<string, unknown>) ?? {},
      ...(typeof r.instructions === "string" ? { instructions: r.instructions } : {}),
    };
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this.init;
  }

  /** Send a request upstream on behalf of a client and resolve with its outcome. */
  call(
    method: string,
    params: Record<string, unknown> | undefined,
    origin?: ClientPort,
    originId?: Id,
    timeoutMs?: number,
  ): Promise<Outcome> {
    if (this.closed) return Promise.resolve(rpcError(ErrorCode.Unavailable, `${this.label} is not running`));
    const id = `u${this.nextId++}`;
    let outParams = params;
    const meta = params?._meta as Record<string, unknown> | undefined;
    if (origin && meta && meta.progressToken !== undefined) {
      const token = `p${id}`;
      this.progress.set(token, { origin, token: meta.progressToken, ...(originId !== undefined ? { originId } : {}) });
      outParams = { ...params, _meta: { ...meta, progressToken: token } };
    }
    this.lastActivity = Date.now();
    return new Promise<Outcome>((resolve) => {
      const p: Pending = { resolve, method, ...(origin ? { origin } : {}), ...(originId !== undefined ? { originId } : {}) };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.cancelUpstream(id, "timed out");
          const secs = Math.round(timeoutMs / 100) / 10;
          this.settle(id, rpcError(ErrorCode.RequestTimeout, `${this.label}: ${method} timed out after ${secs}s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      const hadSession = this.hasRemoteSession();
      this.send({ jsonrpc: "2.0", id, method, ...(outParams ? { params: outParams } : {}) }).catch((err) => {
        if (sessionGone(err, hadSession)) {
          this.sessionLost = true;
          this.settle(id, rpcError(ErrorCode.Unavailable, `${this.label}: the remote server forgot the session`));
          void this.close("remote session expired");
          return;
        }
        this.settle(id, rpcError(ErrorCode.Unavailable, `${this.label}: ${(err as Error).message}`));
      });
    });
  }

  /** Forward a client notification (cancelled, roots/list_changed, ...). */
  notify(method: string, params: Record<string, unknown> | undefined, origin?: ClientPort): void {
    if (this.closed) return;
    if (method === "notifications/cancelled") {
      if (params?.requestId === undefined) return;
      const upstreamId = this.findUpstreamId(params.requestId as Id, origin?.id);
      if (!upstreamId) return;
      // The server will never answer a cancelled request (the spec says it must not), so
      // settle it here: otherwise it stays in flight forever and the instance never idles out.
      this.cancelUpstream(upstreamId, typeof params.reason === "string" ? params.reason : undefined);
      this.settle(upstreamId, rpcError(ErrorCode.RequestCancelled, "cancelled by the client"));
      return;
    }
    this.lastActivity = Date.now();
    void this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => {});
  }

  /** A client went away: cancel and settle everything it had in flight, forget its progress tokens. */
  forgetClient(client: ClientPort, reason = "client disconnected"): number {
    let n = 0;
    for (const [id, p] of [...this.pending]) {
      if (p.origin !== client) continue;
      this.cancelUpstream(id, reason);
      this.settle(id, rpcError(ErrorCode.RequestCancelled, reason));
      n++;
    }
    for (const [token, p] of this.progress) if (p.origin === client) this.progress.delete(token);
    return n;
  }

  /** Fetch every page of a list method. */
  async listAll(method: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.call(method, cursor ? { cursor } : undefined, undefined, undefined, 60_000);
      if ("error" in res) throw new Error(`${this.label}: ${method}: ${res.error.message}`);
      items.push(...((res.result[key] as unknown[]) ?? []));
      cursor = res.result.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return items;
  }

  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(`${this.label} stopped`);
    try {
      await this.transport?.close();
    } catch {
      /* already gone */
    }
    this.opts.onClose?.(reason);
  }

  private hasRemoteSession(): boolean {
    return typeof (this.transport as { sessionId?: unknown } | undefined)?.sessionId === "string";
  }

  private cancelUpstream(id: Id, reason?: string): void {
    if (this.closed || !this.transport) return;
    const params: Record<string, unknown> = { requestId: id, ...(reason ? { reason } : {}) };
    void this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params }).catch(() => {});
  }

  private findUpstreamId(clientId: Id, originId: string | undefined): Id | undefined {
    for (const [id, p] of this.pending) {
      if (p.originId === clientId && (!originId || p.origin?.id === originId)) return id;
    }
    return undefined;
  }

  private async send(m: Message): Promise<void> {
    if (!this.transport) throw new Error("not started");
    await this.transport.send(m as never);
  }

  private settle(id: Id, o: Outcome): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.progress.delete(`p${id}`);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(o);
  }

  private failAll(message: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(rpcError(ErrorCode.Unavailable, message));
    }
    this.progress.clear();
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(`${this.label} exited`);
    this.opts.onClose?.(reason);
  }

  /**
   * The client a server-to-client message belongs to. Stdio carries no link between a server
   * request and the call that caused it, so: an explicit related request id wins; else the one
   * client with calls in flight; else the only attached client. With calls in flight from
   * several clients the message is refused rather than sent to a guess (ADR 0016).
   */
  private route(method: string, params: Record<string, unknown> | undefined): Route {
    const meta = params?._meta as Record<string, unknown> | undefined;
    const related = meta?.relatedRequestId;
    if (typeof related === "string" || typeof related === "number") {
      const p = this.pending.get(related);
      if (p?.origin) return { origin: p.origin, ...(p.originId !== undefined ? { originId: p.originId } : {}) };
    }
    const latest = new Map<ClientPort, Pending>();
    for (const p of this.pending.values()) if (p.origin) latest.set(p.origin, p);
    if (latest.size === 1) {
      const [[origin, p]] = [...latest.entries()] as [[ClientPort, Pending]];
      return { origin, ...(p.originId !== undefined ? { originId: p.originId } : {}) };
    }
    if (latest.size > 1) {
      return {
        code: ErrorCode.Ambiguous,
        error:
          `${this.label} is shared by ${latest.size} sessions with calls in flight, so turno cannot tell which one this ${method} belongs to. ` +
          `Retry when the other calls finish, or set scope = "session" (or exclusive = true) for this server in mcp.toml.`,
      };
    }
    const attached = this.opts.attached?.() ?? [];
    if (attached.length === 1) return { origin: attached[0] as ClientPort };
    return { code: ErrorCode.MethodNotFound, error: `no client session is waiting on ${this.label}` };
  }

  private onMessage(m: Message): void {
    this.lastActivity = Date.now();
    if (isResponse(m)) {
      this.settle(m.id as Id, "error" in m && m.error ? { error: m.error } : { result: m.result ?? {} });
      return;
    }
    if (isRequest(m)) {
      void this.relayRequest(m);
      return;
    }
    if (isNotification(m)) this.relayNotification(m);
  }

  private declared(capability: string): boolean {
    const caps = this.opts.capabilities ?? { roots: {}, elicitation: {} };
    return caps[capability] !== undefined;
  }

  private async answer(method: string, params: Record<string, unknown> | undefined): Promise<Outcome> {
    if (method === "ping") return { result: {} };
    const capability = CLIENT_CAPABILITY[method];
    if (method === "roots/list") {
      const local = this.opts.localRoots?.();
      if (local) return { result: local };
    }
    if (capability && !this.declared(capability)) {
      return rpcError(ErrorCode.MethodNotFound, `turno did not offer ${capability} to ${this.label}`);
    }
    const target = this.route(method, params);
    if ("error" in target) {
      this.opts.log?.(`${this.label}: refused ${method}: ${target.error}`);
      return rpcError(target.code, target.error);
    }
    if (capability && target.origin.supports && !target.origin.supports(capability)) {
      return rpcError(ErrorCode.MethodNotFound, `the client session behind ${this.label} does not support ${capability}`);
    }
    return target.origin.request(method, params, target.originId);
  }

  private async relayRequest(m: Message): Promise<void> {
    const id = m.id as Id;
    const outcome = await this.answer(m.method as string, m.params);
    const reply: Message = "error" in outcome ? { jsonrpc: "2.0", id, error: outcome.error } : { jsonrpc: "2.0", id, result: outcome.result };
    await this.send(reply).catch(() => {});
  }

  private relayNotification(m: Message): void {
    const method = m.method as string;
    if (method === "notifications/progress") {
      const token = String(m.params?.progressToken);
      const p = this.progress.get(token);
      if (p) p.origin.notify(method, { ...m.params, progressToken: p.token }, p.originId);
      return;
    }
    if (method === "notifications/cancelled") {
      // The server gave up on a request it sent us; nothing to undo on our side.
      return;
    }
    if (ROUTED_NOTIFICATIONS.has(method)) {
      const target = this.route(method, m.params);
      if (!("error" in target)) {
        target.origin.notify(method, m.params, target.originId);
        return;
      }
      // Several sessions in flight: a log line or completion for one of them must not reach the others.
      if (target.code === ErrorCode.Ambiguous) return;
    }
    this.opts.onBroadcast?.(method, m.params);
  }
}
