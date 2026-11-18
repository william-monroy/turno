import { describe, expect, it } from "vitest";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import type { CallEvent } from "../src/mcpd/calllog.js";
import type { ClientContext, ClientHandle, InstanceManager } from "../src/mcpd/instances.js";
import { ErrorCode, type Outcome } from "../src/mcpd/jsonrpc.js";
import { type CallStage, CallPipeline, SESSION_META, type ToolCall, createCallPipeline } from "../src/mcpd/middleware.js";

/**
 * The call middleware (ADR 0047): every tools/call of both protocol paths goes through one
 * pipeline before the instance manager relays it. Here with a fake relay; the gateway tests
 * (mcpd-protocol.test.ts) run it end to end on both paths.
 */

function client(over: Partial<ClientContext> = {}): ClientHandle {
  return {
    id: over.sessionId ?? "s1",
    ctx: { serverName: "fx", sessionId: "s1", profile: "work", pid: 4242, clientName: "claude-code", ...over },
    lastSeen: 0,
    notify: () => {},
    request: async () => ({ result: {} }),
  };
}

/** A manager whose forward records what it was asked to relay and answers ok on variant "work". */
function fakeManager(answer: (params: Record<string, unknown> | undefined) => Outcome = () => ({ result: { content: [] } })) {
  const relayed: { method: string; params: Record<string, unknown> | undefined }[] = [];
  const manager = {
    async forward(_c: ClientHandle, method: string, params: Record<string, unknown> | undefined, _id: unknown, _cancelled?: () => boolean, onVariant?: (v: string) => void) {
      relayed.push({ method, params });
      onVariant?.("work");
      return answer(params);
    },
  } as unknown as InstanceManager;
  return { manager, relayed };
}

const manifest = (toml: string): (() => Manifest) => {
  const m = parseManifest(toml);
  return () => m;
};
const FX = '[server.fx]\ncommand = "fx"\n';

function pipeline(o: { toml?: string; stages?: CallStage[]; events?: CallEvent[]; answer?: (p: Record<string, unknown> | undefined) => Outcome } = {}) {
  const fake = fakeManager(o.answer);
  const p = createCallPipeline({
    manager: fake.manager,
    manifest: manifest(o.toml ?? FX),
    ...(o.events ? { callLog: () => (e: CallEvent) => o.events!.push(e) } : {}),
    ...(o.stages ? { stages: o.stages } : {}),
  });
  return { p, ...fake };
}

/** A test-only stage: notes when a call enters and leaves it, and what it saw. */
function probe(name: string, trail: string[], seen?: Record<string, unknown>[]): CallStage {
  return {
    name,
    async run(call, next) {
      trail.push(`${name}:in`);
      seen?.push(structuredClone(call.params));
      const out = await next(call);
      trail.push(`${name}:out`);
      return out;
    },
  };
}

const call = (p: CallPipeline, c: ClientHandle, params: Record<string, unknown>, id: string | number = 1) => p.call(c, params, id, () => false);

describe("the call pipeline", () => {
  it("runs filter, the opt-in stages in their order, call log and session, then the relay", async () => {
    const trail: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const events: CallEvent[] = [];
    const { p, relayed } = pipeline({ stages: [probe("test-a", trail, seen), probe("test-b", trail)], events });
    expect(p.names()).toEqual(["filter", "test-a", "test-b", "calllog", "session"]);
    const out = await call(p, client(), { name: "echo", arguments: { text: "hi" } });
    expect(out).toEqual({ result: { content: [] } });
    expect(trail).toEqual(["test-a:in", "test-b:in", "test-b:out", "test-a:out"]);
    // The opt-in stages run before the session is added, and the relay gets it.
    expect(seen[0]).toEqual({ name: "echo", arguments: { text: "hi" } });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.method).toBe("tools/call");
    expect(Object.keys((relayed[0]!.params as { _meta: object })._meta)).toEqual([SESSION_META]);
    expect(events).toHaveLength(1);
  });

  it("refuses a tool the profile's filter hides before any other stage, and logs nothing", async () => {
    const trail: string[] = [];
    const events: CallEvent[] = [];
    const { p, relayed } = pipeline({ toml: `${FX}tools = { deny = ["hang"] }\n`, stages: [probe("test-a", trail)], events });
    const out = await call(p, client(), { name: "hang", arguments: {} });
    expect(out).toEqual({
      error: { code: ErrorCode.InvalidParams, message: "tool hang of fx is not available to profile work (tools.allow / tools.deny in mcp.toml)" },
    });
    expect(trail).toEqual([]);
    expect(relayed).toEqual([]);
    expect(events).toEqual([]);
    expect(await call(p, client({ profile: undefined }), { name: "hang" })).toMatchObject({ error: { message: /not available to profile default/ } });
    expect(await call(p, client(), { name: "echo" })).toEqual({ result: { content: [] } });
  });

  it("is off by default: with no opt-in stage it has only the built-in ones", () => {
    expect(pipeline().p.names()).toEqual(["filter", "calllog", "session"]);
  });

  it("refuses two stages with one name, and the built-in names", () => {
    const noop = (name: string): CallStage => ({ name, run: (c, next) => next(c) });
    expect(() => pipeline({ stages: [noop("trim"), noop("trim")] })).toThrow('call stage "trim" is registered twice');
    for (const reserved of ["filter", "calllog", "session"]) expect(() => pipeline({ stages: [noop(reserved)] })).toThrow(`call stage "${reserved}" is registered twice`);
    expect(() => pipeline({ stages: [noop("Bad Name")] })).toThrow(/must match/);
    expect(() => new CallPipeline({} as InstanceManager, [noop("a"), noop("a")])).toThrow(/twice/);
  });

  it("puts one stable id per client session in _meta, keeps the client's own keys and overwrites a forged one", async () => {
    const { p, relayed } = pipeline();
    const a = client();
    const b = client({ sessionId: "s2" });
    await call(p, a, { name: "echo", _meta: { progressToken: 7, [SESSION_META]: "forged", "example.com/k": "v" } });
    await call(p, a, { name: "echo" });
    await call(p, b, { name: "echo" });
    const ids = relayed.map((r) => (r.params?._meta as Record<string, unknown> | undefined)?.[SESSION_META]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids).not.toContain("forged");
    expect(ids).not.toContain("s1");
    expect(relayed[0]!.params?._meta).toEqual({ progressToken: 7, [SESSION_META]: ids[0], "example.com/k": "v" });
  });

  it("logs each call with the variant the relay used and the arguments as the client sent them", async () => {
    const events: CallEvent[] = [];
    const { p } = pipeline({ events, answer: () => ({ error: { code: ErrorCode.RequestTimeout, message: "timed out" } }) });
    const before = Date.now();
    await call(p, client(), { name: "echo", arguments: { text: "x" } });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ method: "tools/call", variant: "work", params: { name: "echo", arguments: { text: "x" } }, outcome: { error: { code: ErrorCode.RequestTimeout } } });
    expect(e.ctx.serverName).toBe("fx");
    expect(e.startedAt).toBeGreaterThanOrEqual(before);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("writes no record while the call log is off, and a stage that throws fails only that call", async () => {
    let sink: ((e: CallEvent) => void) | undefined;
    const events: CallEvent[] = [];
    const fake = fakeManager();
    const boom: CallStage = { name: "test-boom", run: async (c, next) => ((c.params as { name?: string }).name === "boom" ? Promise.reject(new Error("stage failed")) : next(c)) };
    const p = createCallPipeline({ manager: fake.manager, manifest: manifest(FX), callLog: () => sink, stages: [boom] });
    await call(p, client(), { name: "echo" });
    sink = (e) => events.push(e);
    await call(p, client(), { name: "echo" });
    expect(events).toHaveLength(1);
    await expect(call(p, client(), { name: "boom" })).rejects.toThrow("stage failed");
    expect(await call(p, client(), { name: "echo" })).toEqual({ result: { content: [] } });
  });

  it("gives every stage the call it needs: client, tool, origin id and cancellation", async () => {
    const got: ToolCall[] = [];
    const spy: CallStage = { name: "test-spy", run: (c, next) => (got.push(c), next(c)) };
    const { p } = pipeline({ stages: [spy] });
    let cancelled = false;
    const c = client();
    await p.call(c, { name: "echo" }, "h7", () => cancelled);
    expect(got[0]).toMatchObject({ client: c, tool: "echo", originId: "h7" });
    cancelled = true;
    expect(got[0]!.cancelled()).toBe(true);
  });
});
