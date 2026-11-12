import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type Id, type Message, type Outcome, isNotification, isRequest, isResponse, rpcError } from "./jsonrpc.js";

/** The client side an upstream talks back to: one Claude Code MCP session. */
export interface ClientPort {
  readonly id: string;
  /** Send a notification to the client, on the stream of `related` when given. */
  notify(method: string, params: Record<string, unknown> | undefined, related?: Id): void;
  /** Relay a server-to-client request (roots, elicitation, sampling) and wait for the answer. */
  request(method: string, params: Record<string, unknown> | undefined, related?: Id): Promise<Outcome>;
}

interface Pending {
  resolve: (o: Outcome) => void;
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
  /** Notifications that are not tied to a request (list_changed, logging, resources/updated). */
  onBroadcast?: (method: string, params: Record<string, unknown> | undefined) => void;
  onClose?: (reason: string) => void;
  /** Milliseconds to wait for initialize. */
  initTimeoutMs?: number;
  pid?: () => number | null | undefined;
}

/**
 * One running MCP server, spoken to over a raw transport. Request ids and progress tokens
 * are rewritten so several clients can share it without their messages crossing.
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
        capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
        clientInfo: { name: "claudio-mcpd", version: "0.1.0" },
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
      const p: Pending = { resolve, ...(origin ? { origin } : {}), ...(originId !== undefined ? { originId } : {}) };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(rpcError(ErrorCode.Unavailable, `${this.label}: ${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.send({ jsonrpc: "2.0", id, method, ...(outParams ? { params: outParams } : {}) }).catch((err) => {
        this.settle(id, rpcError(ErrorCode.Unavailable, `${this.label}: ${(err as Error).message}`));
      });
    });
  }

  /** Forward a client notification (cancelled, roots/list_changed, ...). */
  notify(method: string, params: Record<string, unknown> | undefined, origin?: ClientPort): void {
    if (this.closed) return;
    let out = params;
    if (method === "notifications/cancelled" && params?.requestId !== undefined) {
      const upstreamId = this.findUpstreamId(params.requestId as Id, origin?.id);
      if (!upstreamId) return;
      out = { ...params, requestId: upstreamId };
    }
    this.lastActivity = Date.now();
    void this.send({ jsonrpc: "2.0", method, ...(out ? { params: out } : {}) }).catch(() => {});
  }

  /** Drop everything a client had in flight (it went away). */
  forgetClient(client: ClientPort): void {
    for (const [token, p] of this.progress) if (p.origin === client) this.progress.delete(token);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(rpcError(ErrorCode.Unavailable, `${this.label} stopped`));
      this.pending.delete(id);
    }
    try {
      await this.transport?.close();
    } catch {
      /* already gone */
    }
    this.opts.onClose?.("closed");
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

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(rpcError(ErrorCode.Unavailable, `${this.label} exited`));
      this.pending.delete(id);
    }
    this.opts.onClose?.(reason);
  }

  /** The client whose request is in flight, most recent first. */
  private activeOrigin(): { origin: ClientPort; originId?: Id } | undefined {
    const all = [...this.pending.values()].filter((p) => p.origin);
    const last = all[all.length - 1];
    return last?.origin ? { origin: last.origin, ...(last.originId !== undefined ? { originId: last.originId } : {}) } : undefined;
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

  private async relayRequest(m: Message): Promise<void> {
    const id = m.id as Id;
    const method = m.method as string;
    let outcome: Outcome;
    if (method === "ping") {
      outcome = { result: {} };
    } else {
      const target = this.activeOrigin();
      outcome = target
        ? await target.origin.request(method, m.params, target.originId)
        : rpcError(ErrorCode.MethodNotFound, `no client session is waiting on ${this.label}`);
    }
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
    if (method === "notifications/message") {
      const target = this.activeOrigin();
      if (target) {
        target.origin.notify(method, m.params, target.originId);
        return;
      }
    }
    this.opts.onBroadcast?.(method, m.params);
  }
}
