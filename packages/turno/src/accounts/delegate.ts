import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.js";
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
  /** Caller's working directory; the run starts there when it exists, else in the home. */
  cwd?: string;
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
}

export const DEFAULT_MAX_TURNS = 15;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** The bridge itself: never reachable from a delegated run, so delegation cannot recurse. */
export const BRIDGE_TOOLS = "mcp__accounts__*";

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
export function delegationPrompt(account: Account, task: string, write: boolean): string {
  const what = account.description ? `${account.id} (${account.description})` : account.id;
  return [
    "You are running headless on behalf of another Claude Code session, through the turno accounts bridge.",
    `Account: ${what}, service ${account.service}.`,
    `Use only these tools to reach it: ${account.tools.join(", ")}.`,
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
 * The enforced command line (ADR 0004, decision 3): headless, `dontAsk` so a global
 * `bypassPermissions` default cannot leak in, no built-in tools, only the account's tools
 * allowed, and the bridge itself disallowed.
 */
export function buildDelegation(req: DelegateRequest, env: NodeJS.ProcessEnv = process.env): RunSpec {
  const home = paths(env).home;
  const cwd = req.cwd && isDir(req.cwd) ? req.cwd : home;
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.TURNO_SESSION_PID;
  return {
    command: launcherPath(req.account.profile, env),
    args: [
      "-p",
      delegationPrompt(req.account, req.task, req.write),
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--allowedTools",
      ...req.account.tools,
      "--disallowedTools",
      BRIDGE_TOOLS,
      "--output-format",
      "json",
      "--max-turns",
      String(req.maxTurns ?? DEFAULT_MAX_TURNS),
    ],
    cwd,
    env: childEnv,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Default runner: own process group, killed as a whole on timeout or abort. */
export const spawnRunner: Runner = (spec, signal) =>
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
  const spec = buildDelegation(req, env);
  const started = now();
  const out = await (opts.runner ?? spawnRunner)(spec, opts.signal);
  const durationMs = now() - started;
  const json = parseClaudeJson(out.stdout);
  const costUsd = typeof json?.total_cost_usd === "number" ? json.total_cost_usd : null;
  const numTurns = typeof json?.num_turns === "number" ? json.num_turns : null;
  if (out.cancelled || (opts.signal?.aborted && !json)) {
    return { ok: false, cancelled: true, text: `Delegation to ${req.account.profile} was cancelled; its process was stopped.`, costUsd, numTurns, durationMs };
  }
  if (out.timedOut) {
    return { ok: false, text: `Delegation to ${req.account.profile} timed out after ${Math.round(spec.timeoutMs / 1000)}s.`, costUsd, numTurns, durationMs };
  }
  if (!json) {
    const why = tail(out.stderr) || tail(out.stdout) || "no output";
    return { ok: false, text: `Delegation to ${req.account.profile} failed (exit ${out.code ?? "?"}): ${why}`, costUsd, numTurns, durationMs };
  }
  const result = typeof json.result === "string" ? json.result : "";
  const isError = json.is_error === true || out.code !== 0;
  let text = result;
  if (!text) {
    text = isError
      ? `Delegation to ${req.account.profile} ended with an error${typeof json.subtype === "string" ? ` (${json.subtype})` : ""}${out.stderr.trim() ? `: ${tail(out.stderr)}` : "."}`
      : "(the delegated run returned no text)";
  }
  return { ok: !isError, text, costUsd, numTurns, durationMs };
}
