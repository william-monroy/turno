import { randomUUID } from "node:crypto";
import type {
  CLIENT_META_KEY,
  SESSION_CAPABILITY as BROWSER_SESSION_CAPABILITY,
  SESSION_ENDED_METHOD,
  SESSION_META_KEY,
} from "turno-browser";
import { type Manifest, type ToolFilter, filtersTools, toolAllowed, toolFilterFor } from "../core/manifest.js";
import type { CallEvent } from "./calllog.js";
import type { ClientContext, ClientHandle, InstanceManager } from "./instances.js";
import { ErrorCode, type Id, type Outcome, rpcError } from "./jsonrpc.js";

/**
 * The call middleware. Every `tools/call` mcpd relays, from a 2025-11-25 session
 * (gateway.ts) or a 2026-07-28 stateless request (modern.ts), goes through one pipeline of
 * named stages before `InstanceManager.forward`:
 *
 *     filter -> <opt-in stages, in order> -> calllog -> session -> forward
 *
 * - `filter` refuses a tool the profile's `tools.allow` / `tools.deny` hides. A
 *   refused call reaches no other stage and is not logged.
 * - opt-in stages (none ship yet; later tool-output trimming, local telemetry counters, a cost
 *   meter) are off by default: each is a `CallStage` that something turns on explicitly. They
 *   see the call as the client sent it, and the outcome the client gets.
 * - `calllog` times the call and hands one event to the call log when it is on.
 * - `session` puts the client session id in the forwarded `_meta` (`io.turno/session`), and the
 *   client's name (`io.turno/client`) when it gave one in initialize.
 *
 * Stage names are unique, lowercase, and never a built-in name.
 */

/**
 * The `_meta` key of the client session id. Typed by turno-browser's own constant (a type
 * import, erased at build): if the two ever differ, the typecheck fails.
 */
export const SESSION_META: typeof SESSION_META_KEY = "io.turno/session";

/**
 * The `_meta` key of the client's own name (`clientInfo.name` from its initialize), sent next to
 * the session id when mcpd knows it, so turno-browser's agent cursor names the agent, not mcpd.
 */
export const CLIENT_META: typeof CLIENT_META_KEY = "io.turno/client";

/**
 * A server that declares this experimental capability in `initialize` hears, with
 * `SESSION_ENDED`, when a client session that made a call to it ends (`InstanceManager.detach`).
 * turno-browser uses it to free that session's tabs at once (`"sharing": "tabs"`).
 */
export const SESSION_CAPABILITY: typeof BROWSER_SESSION_CAPABILITY = "io.turno/sessions";
export const SESSION_ENDED: typeof SESSION_ENDED_METHOD = "notifications/io.turno/session_ended";

/** The session id of each client handle, made on its first call. */
const sessionIds = new WeakMap<ClientHandle, string>();

/** The id the `session` stage gave this client, or undefined when it made no call. */
export function sessionIdOf(client: ClientHandle): string | undefined {
  return sessionIds.get(client);
}

/** One tools/call on its way through the pipeline. A stage may replace `params` for the stages after it. */
export interface ToolCall {
  readonly client: ClientHandle;
  /** The tool name the client asked for (`params.name`), "" when it sent none. */
  readonly tool: string;
  params: Record<string, unknown>;
  /** The id the call is relayed under (the client's, or mcpd's own for a stateless request). */
  readonly originId: Id;
  /** Whether the client cancelled the call. */
  readonly cancelled: () => boolean;
  /** The variant of the instance that served the call, set by the relay (undefined when none started). */
  variant?: string;
}

type NextStage = (call: ToolCall) => Promise<Outcome>;

/** One step of the pipeline: do something, call `next` (or answer without it), return the outcome. */
export interface CallStage {
  readonly name: string;
  run(call: ToolCall, next: NextStage): Promise<Outcome>;
}

const BUILT_IN = ["filter", "calllog", "session"] as const;
const STAGE_NAME = /^[a-z][a-z0-9-]*$/;

/** A profile's tool filter for a client's server, or undefined when it filters nothing. */
export function toolFilterOf(manifest: Manifest, ctx: ClientContext): ToolFilter | undefined {
  const server = manifest.servers[ctx.serverName];
  if (!server) return undefined;
  const f = toolFilterFor(server, ctx.profile);
  return filtersTools(f) ? f : undefined;
}

/** `filter`: a tool the profile's filter hides is refused here, before anything else runs. */
function filterStage(manifest: () => Manifest): CallStage {
  return {
    name: "filter",
    run(call, next) {
      const filter = toolFilterOf(manifest(), call.client.ctx);
      if (filter && !toolAllowed(filter, call.tool)) {
        const { serverName, profile } = call.client.ctx;
        return Promise.resolve(
          rpcError(
            ErrorCode.InvalidParams,
            `tool ${call.tool} of ${serverName} is not available to profile ${profile ?? "default"} (tools.allow / tools.deny in mcp.toml)`,
          ),
        );
      }
      return next(call);
    },
  };
}

/** `calllog`: times the call and reports it to the call log, when one is on (read per call). */
function callLogStage(sink: () => ((event: CallEvent) => void) | undefined): CallStage {
  return {
    name: "calllog",
    async run(call, next) {
      const startedAt = Date.now();
      const t0 = performance.now();
      const params = call.params;
      const outcome = await next(call);
      const record = sink();
      if (record) {
        try {
          record({
            ctx: call.client.ctx,
            method: "tools/call",
            params,
            ...(call.variant ? { variant: call.variant } : {}),
            outcome,
            startedAt,
            durationMs: performance.now() - t0,
          });
        } catch {
          /* observing a call never fails it */
        }
      }
      return outcome;
    },
  };
}

/**
 * `session`: the client session id in `_meta[SESSION_META]`. A random UUID per client handle
 * (one 2025-11-25 session, or one stateless client: profile, server, PID and folder), kept for
 * the life of the handle. It is not the Mcp-Session-Id, so a server learns nothing it could use
 * against mcpd. With it goes the client's name (`_meta[CLIENT_META]`) when initialize gave one. Values
 * the client sent under either key are replaced.
 */
function sessionStage(): CallStage {
  return {
    name: "session",
    run(call, next) {
      let id = sessionIds.get(call.client);
      if (!id) {
        id = randomUUID();
        sessionIds.set(call.client, id);
      }
      const meta =
        typeof call.params._meta === "object" && call.params._meta !== null
          ? (call.params._meta as Record<string, unknown>)
          : {};
      const { [CLIENT_META]: _sent, ...rest } = meta;
      const name = call.client.ctx.clientName;
      call.params = {
        ...call.params,
        _meta: { ...rest, [SESSION_META]: id, ...(name ? { [CLIENT_META]: name } : {}) },
      };
      return next(call);
    },
  };
}

/** The ordered stages, and the relay through the instance manager at the end. */
export class CallPipeline {
  private readonly stages: readonly CallStage[];

  constructor(
    private readonly manager: InstanceManager,
    stages: readonly CallStage[],
  ) {
    const seen = new Set<string>();
    for (const s of stages) {
      if (!STAGE_NAME.test(s.name)) throw new Error(`call stage name "${s.name}" must match ${STAGE_NAME}`);
      if (seen.has(s.name)) throw new Error(`call stage "${s.name}" is registered twice`);
      seen.add(s.name);
    }
    this.stages = [...stages];
  }

  /** The stage names in the order a call meets them. */
  names(): string[] {
    return this.stages.map((s) => s.name);
  }

  /** Relay one tools/call through every stage, then `InstanceManager.forward`. */
  call(
    client: ClientHandle,
    params: Record<string, unknown>,
    originId: Id,
    cancelled: () => boolean,
  ): Promise<Outcome> {
    const relay: NextStage = (c) =>
      this.manager.forward(
        c.client,
        "tools/call",
        c.params,
        c.originId,
        c.cancelled,
        (variant) => (c.variant = variant),
      );
    const run = this.stages.reduceRight<NextStage>((next, stage) => (c) => stage.run(c, next), relay);
    return run({ client, tool: typeof params.name === "string" ? params.name : "", params, originId, cancelled });
  }
}

export interface PipelineOptions {
  manager: InstanceManager;
  /** The current manifest: the filter reads it on every call, so a reload applies at once. */
  manifest: () => Manifest;
  /** Where call events go while the call log is on; read per call (`[mcpd] call_log` can change). */
  callLog?: () => ((event: CallEvent) => void) | undefined;
  /** Opt-in stages, after `filter` and before `calllog`, in this order. None by default. */
  stages?: readonly CallStage[];
}

/** mcpd's pipeline: the built-in stages around the opt-in ones. */
export function createCallPipeline(opts: PipelineOptions): CallPipeline {
  const stages = opts.stages ?? [];
  for (const s of stages)
    if ((BUILT_IN as readonly string[]).includes(s.name)) throw new Error(`call stage "${s.name}" is registered twice`);
  return new CallPipeline(opts.manager, [
    filterStage(opts.manifest),
    ...stages,
    callLogStage(opts.callLog ?? (() => undefined)),
    sessionStage(),
  ]);
}
