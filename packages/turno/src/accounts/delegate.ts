import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_FILE_MODE, ensurePrivateDir, paths, profileDir } from "../core/paths.js";
import type { Account } from "./registry.js";

/** A process to run: built by `buildDelegation`, executed by a `Runner`. */
export interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The caller aborted the run (the MCP call was cancelled); the process group was killed. */
  cancelled?: boolean;
}

/**
 * Runs a process to completion, or until `signal` aborts. Injectable so tests never start a
 * real Claude Code.
 */
export type Runner = (spec: RunSpec, signal?: AbortSignal) => Promise<RunOutput>;

export interface DelegateRequest {
  account: Account;
  task: string;
  write: boolean;
  /** Tool patterns the run may call (the policy's decision); the account's tools by default. */
  tools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}

export interface DelegateResult {
  ok: boolean;
  text: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  /** The run was cancelled before it finished. */
  cancelled?: boolean;
  /** Tools the run tried to call and Claude Code refused (outside the allowed set). */
  denied: string[];
  /** `strict`: only the account's gateway servers were loaded; `profile`: the profile's MCP config. */
  mcp: "strict" | "profile";
}

export const DEFAULT_MAX_TURNS = 15;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** The bridge itself: never reachable from a delegated run, so delegation cannot recurse. */
const BRIDGE_TOOLS = "mcp__accounts__*";

/** Path of a profile's launcher (`claude-<profile>` in the turno bin dir). */
export function launcherPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).bin, `claude-${profile}`);
}

export function launcherExists(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return statSync(launcherPath(profile, env)).isFile();
  } catch {
    return false;
  }
}

/** The prompt the owning profile receives. */
function delegationPrompt(account: Account, task: string, write: boolean, tools: string[] = account.tools): string {
  const what = account.description ? `${account.id} (${account.description})` : account.id;
  return [
    "You are running headless on behalf of another Claude Code session, through the turno accounts bridge.",
    `Account: ${what}, service ${account.service}.`,
    `Use only these tools to reach it: ${tools.join(", ")}. Any other tool is refused.`,
    write
      ? "Write actions (creating, sending, posting, editing or deleting) are allowed for this task: the user confirmed it. Do only what the task asks."
      : "Write actions are NOT allowed: only read. If the task needs a write (creating, sending, posting, editing or deleting), do not do it; describe exactly what you would do instead.",
    "",
    "Task:",
    task,
    "",
    "When you are done, reply with a concise outcome: what you did or found, with identifiers and links when relevant. No preamble.",
  ].join("\n");
}

/**
 * Environment variables the delegated run keeps (plus every `LC_*`). Everything else in
 * mcpd's environment is dropped: another profile's `CLAUDE_CONFIG_DIR`, API keys, the session
 * variables of whoever started mcpd.
 */
const ENV_ALLOW = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** The minimal environment of a delegated run, from mcpd's own. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if ((ENV_ALLOW as readonly string[]).includes(k) || k.startsWith("LC_")) out[k] = v;
  }
  return out;
}

/** The MCP server a tool pattern names (`mcp__linear__*` is `linear`); undefined for other patterns. */
export function mcpServerOf(pattern: string): string | undefined {
  if (!pattern.startsWith("mcp__")) return undefined;
  const rest = pattern.slice(5);
  const end = rest.indexOf("__");
  const server = end === -1 ? rest : rest.slice(0, end);
  return server || undefined;
}

/** Claude Code's form of a server name inside tool names. */
function toolName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const GATEWAY_URL = /^http:\/\/127\.0\.0\.1:\d+\/mcp\//;

export interface IsolatedMcp {
  /** Load only `servers` (--strict-mcp-config). */
  strict: boolean;
  /** The owning profile's entries for the account's servers, when strict. */
  servers: Record<string, unknown>;
  /** Why the run falls back to the profile's MCP config. */
  why?: string;
}

/**
 * The MCP config of a delegated run: the owning profile's own entries for the servers its
 * tool patterns name, when each one is a turno gateway entry. Anything else (claude.ai
 * connectors, which --strict-mcp-config does not load; a server missing from the profile; a
 * server that does not go through the gateway, whose entry may hold its own secrets) keeps
 * the profile's MCP config, and the allowed tools are the only limit.
 */
export function isolatedMcp(profile: string, tools: string[], env: NodeJS.ProcessEnv = process.env): IsolatedMcp {
  const wanted = [...new Set(tools.map(mcpServerOf).filter((s): s is string => s !== undefined))];
  const connector = wanted.find((s) => s.startsWith("claude_ai_"));
  if (connector)
    return {
      strict: false,
      servers: {},
      why: `${connector} is a claude.ai connector, which --strict-mcp-config would not load`,
    };
  const wild = wanted.find((s) => s.includes("*"));
  if (wild) return { strict: false, servers: {}, why: `the pattern server "${wild}" is not one server` };
  let configured: Record<string, unknown> = {};
  try {
    const cfg = JSON.parse(readFileSync(join(profileDir(profile, env), ".claude.json"), "utf8")) as {
      mcpServers?: unknown;
    };
    if (cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers))
      configured = cfg.mcpServers as Record<string, unknown>;
  } catch {
    /* no config: every wanted server is missing */
  }
  const servers: Record<string, unknown> = {};
  for (const w of wanted) {
    const name = Object.keys(configured).find((k) => toolName(k) === w);
    if (name === undefined)
      return { strict: false, servers: {}, why: `server "${w}" is not in the MCP config of profile ${profile}` };
    const entry = configured[name] as { url?: unknown } | null;
    if (!entry || typeof entry.url !== "string" || !GATEWAY_URL.test(entry.url)) {
      return { strict: false, servers: {}, why: `server "${w}" does not go through the turno gateway` };
    }
    servers[name] = entry;
  }
  return { strict: true, servers };
}

/** Where a delegated run starts and what MCP config it loads. */
export interface RunFolder {
  /** The working folder: empty, private, owned by turno (never the caller's folder). */
  cwd: string;
  /** The MCP config file (mode 600) when the run loads only the account's servers. */
  mcpConfig?: string;
  mcp: IsolatedMcp;
  /** Remove the per-run files (the MCP config). */
  cleanup(): void;
}

/** Remove what is inside `dir`, keeping the folder itself (a concurrent run may be in it). */
function emptyDir(dir: string): void {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
}

/**
 * Prepare the run of `profile`: an empty working folder under turno's state (one per profile,
 * so Claude Code keeps one project for the bridge) and, when the account's servers allow it, an
 * MCP config with only those servers, in a per-run folder removed by `cleanup`.
 */
export function prepareRun(profile: string, tools: string[], env: NodeJS.ProcessEnv = process.env): RunFolder {
  const root = ensurePrivateDir(join(paths(env).state, "delegate"), env);
  const cwd = ensurePrivateDir(join(root, profile), env);
  emptyDir(cwd);
  const mcp = isolatedMcp(profile, tools, env);
  if (!mcp.strict) return { cwd, mcp, cleanup: () => {} };
  const dir = mkdtempSync(join(root, ".run-"));
  const mcpConfig = join(dir, "mcp.json");
  writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: mcp.servers }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  chmodSync(mcpConfig, PRIVATE_FILE_MODE);
  return { cwd, mcpConfig, mcp, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The enforced command line: headless, `dontAsk` so a global
 * `bypassPermissions` default cannot leak in, no settings files (their allow rules, hooks and
 * plugins would widen the run), no built-in tools, only the decided tools allowed, the bridge
 * itself disallowed, and only the account's servers when the folder has an MCP config.
 */
export function buildDelegation(
  req: DelegateRequest,
  run: Pick<RunFolder, "cwd" | "mcpConfig">,
  env: NodeJS.ProcessEnv = process.env,
): RunSpec {
  const tools = req.tools ?? req.account.tools;
  return {
    command: launcherPath(req.account.profile, env),
    args: [
      "-p",
      delegationPrompt(req.account, req.task, req.write, tools),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      ...(run.mcpConfig ? ["--mcp-config", run.mcpConfig, "--strict-mcp-config"] : []),
      "--tools",
      "",
      "--allowedTools",
      ...tools,
      "--disallowedTools",
      BRIDGE_TOOLS,
      "--output-format",
      "json",
      "--max-turns",
      String(req.maxTurns ?? DEFAULT_MAX_TURNS),
    ],
    cwd: run.cwd,
    env: childEnv(env),
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Default runner: own process group, killed as a whole on timeout or abort. */
const spawnRunner: Runner = (spec, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    let hardKill: NodeJS.Timeout | undefined;
    const stop = () => {
      killGroup("SIGTERM");
      hardKill = setTimeout(() => killGroup("SIGKILL"), 5000);
      hardKill.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    const onAbort = () => {
      if (done) return;
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // After a timeout or abort the hard kill stays armed (unref'd) for grandchildren still alive.
      resolve({ code, stdout, stderr, timedOut, ...(cancelled ? { cancelled } : {}) });
    };
    child.on("error", (err) => {
      stderr += `${err.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

interface ClaudeJson {
  result?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  subtype?: unknown;
  permission_denials?: unknown;
}

/** Tool names from the result's `permission_denials` (calls Claude Code refused). */
function deniedTools(json: { permission_denials?: unknown } | undefined): string[] {
  if (!Array.isArray(json?.permission_denials)) return [];
  const names = json.permission_denials
    .map((d) => (d && typeof d === "object" ? (d as { tool_name?: unknown }).tool_name : undefined))
    .filter((n): n is string => typeof n === "string");
  return [...new Set(names)];
}

/** The JSON object printed by `--output-format json` (the last line that parses). */
export function parseClaudeJson(stdout: string): ClaudeJson | undefined {
  const whole = stdout.trim();
  if (!whole) return undefined;
  try {
    const v = JSON.parse(whole) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as ClaudeJson;
  } catch {
    /* try line by line */
  }
  const lines = whole.split("\n").reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as ClaudeJson;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function tail(text: string, n = 400): string {
  const t = text.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

/** Run the task in the owning profile and interpret Claude Code's JSON result. */
export async function delegate(
  req: DelegateRequest,
  opts: { runner?: Runner; env?: NodeJS.ProcessEnv; now?: () => number; signal?: AbortSignal } = {},
): Promise<DelegateResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const run = prepareRun(req.account.profile, req.tools ?? req.account.tools, env);
  const spec = buildDelegation(req, run, env);
  const started = now();
  let out: RunOutput;
  try {
    out = await (opts.runner ?? spawnRunner)(spec, opts.signal);
  } finally {
    run.cleanup();
  }
  const durationMs = now() - started;
  const json = parseClaudeJson(out.stdout);
  const costUsd = typeof json?.total_cost_usd === "number" ? json.total_cost_usd : null;
  const numTurns = typeof json?.num_turns === "number" ? json.num_turns : null;
  const base = {
    costUsd,
    numTurns,
    durationMs,
    denied: deniedTools(json),
    mcp: run.mcp.strict ? ("strict" as const) : ("profile" as const),
  };
  if (out.cancelled || (opts.signal?.aborted && !json)) {
    return {
      ok: false,
      cancelled: true,
      text: `Delegation to ${req.account.profile} was cancelled; its process was stopped.`,
      ...base,
    };
  }
  if (out.timedOut) {
    return {
      ok: false,
      text: `Delegation to ${req.account.profile} timed out after ${Math.round(spec.timeoutMs / 1000)}s.`,
      ...base,
    };
  }
  if (!json) {
    const why = tail(out.stderr) || tail(out.stdout) || "no output";
    return {
      ok: false,
      text: `Delegation to ${req.account.profile} failed (exit ${out.code ?? "?"}): ${why}`,
      ...base,
    };
  }
  const result = typeof json.result === "string" ? json.result : "";
  const isError = json.is_error === true || out.code !== 0;
  let text = result;
  if (!text) {
    text = isError
      ? `Delegation to ${req.account.profile} ended with an error${typeof json.subtype === "string" ? ` (${json.subtype})` : ""}${out.stderr.trim() ? `: ${tail(out.stderr)}` : "."}`
      : "(the delegated run returned no text)";
  }
  return { ok: !isError, text, ...base };
}
