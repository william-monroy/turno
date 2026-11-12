import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinFactory } from "../mcpd/connectors.js";
import type { ClientContext } from "../mcpd/instances.js";
import { type AuditInput, appendAudit } from "./audit.js";
import { type DelegateResult, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS, type Runner, delegate, launcherExists, launcherPath } from "./delegate.js";
import { type Account, type Registry, loadRegistry, preferredFor } from "./registry.js";

export interface AccountsDeps {
  /** Environment for paths (registry, audit log, launchers) and for the delegated run. */
  env?: NodeJS.ProcessEnv;
  loadRegistry?: () => Registry;
  runner?: Runner;
  /** Whether the owner's `claude-<profile>` launcher exists. */
  launcherExists?: (profile: string) => boolean;
  audit?: (entry: AuditInput) => void;
  maxTurns?: number;
  timeoutMs?: number;
  /** How long the user has to answer the write confirmation form. */
  confirmTimeoutMs?: number;
  /** Interval of progress notifications while a delegation runs (keeps the call alive). */
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * The client's own capabilities, when mcpd passes them in the context. Without them the
 * builtin only sees mcpd's capabilities (which always include elicitation and roots), so an
 * unsupported request is detected from the client's "method not found" answer instead.
 */
type Ctx = ClientContext & { clientCapabilities?: ClientCapabilities };

const TOOLS = [
  {
    name: "accounts_list",
    description:
      "List the service accounts (Linear workspaces, Gmail connectors, ...) known to turno, which Claude profile owns each, " +
      "whether each one is native to this session (reachable directly with its tool patterns) and the preferred account per service for this folder.",
    inputSchema: { type: "object" as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "accounts_delegate",
    description:
      "Run a task against an account owned by another Claude profile: turno runs it headless in that profile with only the account's tools and returns the outcome. " +
      "Set write=true for outward-facing actions (creating, sending, posting, editing, deleting); the user is then asked to confirm. " +
      "For native accounts, use their tools directly instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account id from accounts_list, like linear:work." },
        task: { type: "string", description: "What to do, self-contained: the other profile does not see this conversation." },
        write: { type: "boolean", description: "True when the task changes anything outside (creates, sends, posts, edits, deletes).", default: false },
      },
      required: ["account", "task"],
    },
  },
];

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function money(v: number | null): string {
  return v === null ? "unknown cost" : `$${v.toFixed(4)}`;
}

/** The accounts bridge as a builtin mcpd server (`builtin = "accounts"` in mcp.toml). */
export function accountsBuiltin(deps: AccountsDeps = {}): BuiltinFactory {
  return (rawCtx) => {
    const ctx = rawCtx as Ctx;
    const env = deps.env ?? process.env;
    const now = deps.now ?? Date.now;
    const registry = deps.loadRegistry ?? (() => loadRegistry(env));
    const hasLauncher = deps.launcherExists ?? ((p: string) => launcherExists(p, env));
    const audit = deps.audit ?? ((e: AuditInput) => void appendAudit(e, env));
    const server = new Server(
      { name: "turno-accounts", version: "0.1.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "turno accounts bridge: call accounts_list to see which service accounts exist and which are native here; " +
          "use accounts_delegate to act on an account owned by another profile.",
      },
    );
    const caller = { profile: ctx.profile ?? null, pid: ctx.pid ?? null };
    let folder: string | undefined = ctx.cwd;

    /** The session folder: the X-Turno-Cwd header, else the client's first root. */
    async function sessionFolder(): Promise<string | undefined> {
      if (folder) return folder;
      const caps = ctx.clientCapabilities ?? server.getClientCapabilities();
      if (!caps?.roots) return undefined;
      try {
        const { roots } = await server.listRoots(undefined, { timeout: 10_000 });
        const first = roots.find((r) => r.uri.startsWith("file://"));
        if (first) folder = fileURLToPath(first.uri);
      } catch {
        /* client without roots */
      }
      return folder;
    }

    async function list(): Promise<CallToolResult> {
      const reg = registry();
      const cwd = await sessionFolder();
      const preferred = cwd ? preferredFor(reg, cwd) : {};
      const accounts = Object.values(reg.accounts)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          service: a.service,
          owner: a.profile,
          native: ctx.profile !== undefined && a.profile === ctx.profile,
          tools: a.tools,
          ...(a.description ? { description: a.description } : {}),
          ...(preferred[a.service] === a.id ? { preferred: true } : {}),
        }));
      const body = {
        callerProfile: ctx.profile ?? null,
        folder: cwd ?? null,
        preferred,
        accounts,
        howTo: "Native accounts: call their tools directly. Others: accounts_delegate with the account id; set write=true for outward-facing actions.",
      };
      return text(JSON.stringify(body, null, 2));
    }

    async function confirmWrite(account: Account, task: string): Promise<{ ok: true } | { ok: false; why: string }> {
      const caps = ctx.clientCapabilities ?? server.getClientCapabilities();
      const unsupported =
        "This client does not support MCP elicitation, so a write action cannot be confirmed by the user. Write delegation is refused; do it from a session that supports elicitation, or in the owning profile directly.";
      if (!caps?.elicitation) return { ok: false, why: unsupported };
      try {
        const res = await server.elicitInput(
          {
            mode: "form",
            message:
              `Allow a write action through account ${account.id}, run headless in profile "${account.profile}"` +
              `${ctx.profile ? ` on behalf of profile "${ctx.profile}"` : ""}?\n\n` +
              `Owner: ${account.profile}\nAccount: ${account.id}${account.description ? ` (${account.description})` : ""}\nTools: ${account.tools.join(", ")}\n\nTask:\n${task}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: { type: "boolean", title: "Run this write action", description: "Check to allow it.", default: false },
              },
              required: ["confirm"],
            },
          },
          { timeout: deps.confirmTimeoutMs ?? 10 * 60_000 },
        );
        if (res.action === "accept" && res.content?.confirm === true) return { ok: true };
        return { ok: false, why: res.action === "accept" ? "the user did not check confirm" : `the user chose ${res.action}` };
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) return { ok: false, why: unsupported };
        return { ok: false, why: `confirmation failed: ${(err as Error).message}` };
      }
    }

    async function run(
      account: Account,
      task: string,
      write: boolean,
      progressToken: string | number | undefined,
      send: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>,
    ): Promise<DelegateResult> {
      let beat: NodeJS.Timeout | undefined;
      if (progressToken !== undefined) {
        let n = 0;
        beat = setInterval(() => {
          n += 1;
          void send({
            method: "notifications/progress",
            params: { progressToken, progress: n, message: `waiting for ${account.profile} (${account.id})` },
          }).catch(() => {});
        }, deps.heartbeatMs ?? 15_000);
      }
      try {
        const cwd = await sessionFolder();
        return await delegate(
          {
            account,
            task,
            write,
            ...(cwd ? { cwd } : {}),
            maxTurns: deps.maxTurns ?? DEFAULT_MAX_TURNS,
            timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          { env, now, ...(deps.runner ? { runner: deps.runner } : {}) },
        );
      } finally {
        if (beat) clearInterval(beat);
      }
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      if (req.params.name === "accounts_list") {
        try {
          return await list();
        } catch (err) {
          return text(`Cannot read the accounts registry: ${(err as Error).message}`, true);
        }
      }
      if (req.params.name !== "accounts_delegate") return text(`Unknown tool ${req.params.name}`, true);

      const started = now();
      const accountId = typeof args.account === "string" ? args.account : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const write = args.write === true;
      let owner: string | null = null;
      const record = (outcome: AuditInput["outcome"], detail: string, costUsd: number | null = null, durationMs = now() - started) =>
        audit({ caller, account: accountId, owner, write, task, outcome, detail, durationMs, costUsd });

      if (!accountId || !task) {
        record("error", "missing account or task");
        return text("accounts_delegate needs both account and task.", true);
      }
      let reg: Registry;
      try {
        reg = registry();
      } catch (err) {
        record("error", `registry: ${(err as Error).message}`);
        return text(`Cannot read the accounts registry: ${(err as Error).message}`, true);
      }
      const account = reg.accounts[accountId];
      if (!account) {
        record("error", "unknown account");
        const known = Object.keys(reg.accounts).sort();
        return text(`Unknown account "${accountId}". Known accounts: ${known.length ? known.join(", ") : "none (see turno accounts add)"}.`, true);
      }
      owner = account.profile;
      if (ctx.profile !== undefined && account.profile === ctx.profile) {
        record("refused", "native account: not delegated");
        return text(
          `${account.id} is native to this session (profile ${account.profile}). Do not delegate: call its tools directly (${account.tools.join(", ")}).`,
        );
      }
      if (!hasLauncher(account.profile)) {
        record("error", `launcher missing: ${launcherPath(account.profile, env)}`);
        return text(
          `Cannot delegate to profile "${account.profile}": its launcher ${launcherPath(account.profile, env)} does not exist. Run \`turno setup\` or fix the account's profile.`,
          true,
        );
      }
      if (write) {
        const ok = await confirmWrite(account, task);
        if (!ok.ok) {
          record("refused", ok.why);
          return text(`Write delegation to ${account.id} refused: ${ok.why}. Nothing was run.`, true);
        }
      }
      const progressToken = req.params._meta?.progressToken;
      const res = await run(account, task, write, progressToken, (n) => extra.sendNotification(n));
      record(res.ok ? "ok" : "error", res.ok ? `${res.numTurns ?? "?"} turns` : res.text.slice(0, 500), res.costUsd, res.durationMs);
      const footer = `\n\n[${account.id} via profile ${account.profile}; ${res.numTurns ?? "?"} turns; ${money(res.costUsd)}; ${Math.round(res.durationMs / 1000)}s]`;
      return text(`${res.text}${footer}`, !res.ok);
    });

    return server;
  };
}
