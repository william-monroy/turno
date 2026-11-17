import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, type Paths, paths } from "../../core/paths.js";
import { profileFromConfigDir } from "../../core/profiles.js";
import { resolveProfile } from "../../core/resolve.js";
import { nerdHere } from "../../ui/terminal-id.js";
import { isObj, limits as checkLimits, num, sanitize, sessionId, turns } from "../../statusline/input.js";
import { NAMED_COLORS, PILL_DEFAULTS, type RenderInput, type Window, render, turnsLeft } from "../../statusline/render.js";
import type { Command, Io } from "../io.js";

const USAGE = `Usage:
  turno statusline        render the status line from the JSON Claude Code sends on stdin

Set it in settings.json:
  "statusLine": { "type": "command", "command": "turno statusline" }`;

/** Retry `claude auth status` this often while the plan is unknown (seconds). */
const PLAN_RETRY = 600;
/** Check the gateway this often, and trust a check this long (seconds). */
const HEALTH_EVERY = 60;
const HEALTH_TRUST = 300;

/** Work that starts a background process: run only after the line is written. */
export type Job = () => void;

/** Run `fn`; on any error the status line leaves that field empty instead of failing. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Atomic write that never throws: a full disk or read-only state dir only loses the cache. */
function save(file: string, data: unknown): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    writeFileSync(tmp, JSON.stringify(data), { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function selfScript(): string {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", "main.js"));
}

/** Run `turno statusline --<worker> ...` detached, so rendering never waits for it. */
function background(args: string[]): void {
  try {
    spawn(process.execPath, [selfScript(), "statusline", ...args], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best effort */
  }
}

/** Create `lock` and start the worker, unless a fresh lock says one is already running. */
function lockedJob(lock: string, ttl: number, now: number, args: string[]): Job | undefined {
  try {
    if (now - statSync(lock).mtimeMs / 1000 < ttl) return undefined;
  } catch {
    /* no lock */
  }
  return () => {
    try {
      mkdirSync(dirname(lock), { recursive: true, mode: PRIVATE_DIR_MODE });
      closeSync(openSync(lock, "w", PRIVATE_FILE_MODE));
    } catch {
      return; // without a lock every render would start a worker
    }
    background(args);
  };
}

export function pillColor(config: Config, account: string): number {
  const c = config.profiles[account]?.color;
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    if (/^\d+$/.test(c)) return Number(c);
    if (NAMED_COLORS[c.toLowerCase()] !== undefined) return NAMED_COLORS[c.toLowerCase()]!;
  }
  const names = Object.keys(config.profiles);
  const idx = names.includes(account) ? names.indexOf(account) : [...account].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  return PILL_DEFAULTS[idx % PILL_DEFAULTS.length]!;
}

type Limits = { five_hour?: Window; seven_day?: Window };

/**
 * The account's windows, the freshest any session has seen. Each session carries the values of
 * its own last response, so an idle one has stale data. A session only publishes when its values
 * change (a new response), so a quiet session redrawing never overwrites fresh data from another.
 */
function accountLimits(usageFile: string, cache: string, sid: string | undefined, limits: Limits, now: number): Limits {
  let changedAt = 0;
  if (Object.keys(limits).length && sid) {
    const sig = stableJson(limits);
    const seenFile = join(cache, `rl-${sid}.json`);
    const raw = readJson(seenFile);
    const seen = isObj(raw) ? raw : {};
    if (seen.sig !== sig) {
      changedAt = typeof seen.sig === "string" ? now : 0; // the first time we cannot tell whether the data is new
      save(seenFile, { sig, changed_at: changedAt });
      if (changedAt) save(usageFile, { rate_limits: limits, updated_at: Math.trunc(now) });
    } else {
      changedAt = num(seen.changed_at) ?? 0;
    }
  }
  const shared = readJson(usageFile);
  if (isObj(shared) && isObj(shared.rate_limits) && (num(shared.updated_at) ?? 0) > changedAt) {
    const theirs = checkLimits(shared.rate_limits);
    if (Object.keys(theirs).length) return theirs;
  }
  return limits;
}

const PLAN_NAMES: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

/**
 * The plan recorded for the account. While it is unknown, an empty file marks the last attempt
 * to ask `claude auth status`, and a new attempt starts once it is older than PLAN_RETRY.
 */
function planOf(file: string, now: number, jobs: Job[]): string {
  let plan = "";
  let age = Number.POSITIVE_INFINITY;
  try {
    plan = readFileSync(file, "utf8").trim();
    age = now - statSync(file).mtimeMs / 1000;
  } catch {
    /* never asked */
  }
  if (plan) return PLAN_NAMES[plan] ?? plan;
  if (age > PLAN_RETRY) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
      writeFileSync(file, "", { mode: PRIVATE_FILE_MODE }); // stamps the attempt, so only one render asks
    } catch {
      return ""; // cannot stamp: do not start a worker on every render
    }
    jobs.push(() => background(["--plan", file]));
  }
  return "";
}

/** Cache key of a folder: its path and the config it was resolved with. */
function resolveKey(cwd: string, configFile: string): string {
  const mtime = safe(() => statSync(configFile).mtimeMs, 0);
  return createHash("sha1").update(`${cwd}\0${mtime}`).digest("hex").slice(0, 20);
}

function resolveCached(cwd: string, config: Config, env: NodeJS.ProcessEnv, p: Paths, cache: string, now: number): { chosen: string; assigned: string } {
  if (!cwd) return { chosen: "", assigned: "" };
  const file = join(cache, `resolve-${resolveKey(cwd, p.configFile)}`);
  try {
    if (now - statSync(file).mtimeMs / 1000 < 120) {
      const [chosen = "", assigned = ""] = readFileSync(file, "utf8").split("\x1f");
      return { chosen, assigned };
    }
  } catch {
    /* compute */
  }
  const r = resolveProfile(cwd, config, env);
  try {
    mkdirSync(cache, { recursive: true, mode: PRIVATE_DIR_MODE });
    writeFileSync(file, `${r.chosen}\x1f${r.assigned}`, { mode: PRIVATE_FILE_MODE });
  } catch {
    /* read-only: resolve again next time */
  }
  return { chosen: r.chosen, assigned: r.assigned };
}

function turnHistory(cache: string, sid: string | undefined, promptId: string | undefined, five: Window | undefined): number | undefined {
  if (!sid || !five || five.used_percentage === undefined) return undefined;
  const file = join(cache, `turns-${sid}.json`);
  const hist = turns(readJson(file));
  if (promptId) {
    const entry: [string, number, number | null] = [promptId, five.used_percentage, five.resets_at ?? null];
    const last = hist[hist.length - 1];
    if (!last || last[0] !== promptId || last[1] !== entry[1] || last[2] !== entry[2]) {
      if (last && last[0] === promptId) hist[hist.length - 1] = entry;
      else hist.push(entry);
      save(file, hist.slice(-12));
    }
  }
  return turnsLeft(hist.slice(-12));
}

function gitSpawn(cwd: string): string {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return git(["branch", "--show-current"]) || git(["rev-parse", "--short", "HEAD"]);
}

/**
 * The branch of the repository holding `cwd`, read from its HEAD file (worktrees and submodules
 * through `gitdir:`), or a short commit on a detached HEAD. Only an unusual HEAD runs git.
 */
export function gitBranch(cwd: string): string {
  if (!cwd || !existsSync(cwd)) return "";
  let dir = resolve(cwd);
  for (;;) {
    const dotgit = join(dir, ".git");
    let isFile: boolean | undefined;
    try {
      isFile = statSync(dotgit).isFile();
    } catch {
      /* not here */
    }
    if (isFile !== undefined) {
      let gitdir = dotgit;
      try {
        if (isFile) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
          if (!m) return gitSpawn(cwd);
          gitdir = resolve(dir, m[1]!);
        }
        const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1]!;
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return head.slice(0, 7);
      } catch {
        /* fall back to git */
      }
      return gitSpawn(cwd);
    }
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

interface SessionCost {
  total: number;
  sub: number;
  unknown: string[];
}

function sessionCost(cache: string, sid: string | undefined, transcript: string | undefined, now: number, jobs: Job[]): SessionCost | undefined {
  if (!sid || !transcript) return undefined;
  const out = join(cache, `cost-${sid}.json`);
  const raw = readJson(out);
  const data =
    isObj(raw) && num(raw.total) !== undefined
      ? {
          total: num(raw.total)!,
          sub: num(raw.sub) ?? 0,
          unknown: Array.isArray(raw.unknown) ? raw.unknown.filter((m): m is string => typeof m === "string") : [],
          v: raw.v,
          updated_at: num(raw.updated_at) ?? 0,
        }
      : undefined;
  const stale = !data || data.v !== 2 || now - data.updated_at > 60;
  if (stale) {
    const job = lockedJob(`${out}.lock`, 600, now, ["--cost", transcript, out]);
    if (job) jobs.push(job);
  }
  return data && data.v === 2 ? { total: data.total, sub: data.sub, unknown: data.unknown } : undefined;
}

/** True when the agents were synced to the gateway (`mcp sync`) and its last check failed. */
function gatewayDown(p: Paths, cache: string, now: number, jobs: Job[]): boolean {
  const managed = readJson(p.mcpdManaged);
  if (!isObj(managed) || !Object.values(managed).some((v) => Array.isArray(v) && v.length)) return false;
  const file = join(cache, "mcpd-health.json");
  const raw = readJson(file);
  const at = isObj(raw) ? (num(raw.checked_at) ?? 0) : 0;
  if (now - at > HEALTH_EVERY) {
    const job = lockedJob(`${file}.lock`, 30, now, ["--health", file]);
    if (job) jobs.push(job);
  }
  return isObj(raw) && raw.ok === false && now - at < HEALTH_TRUST;
}

export function useNerd(config: Config, env: NodeJS.ProcessEnv): boolean {
  if (config.icons === "nerd") return true;
  if (config.icons === "unicode") return false;
  return nerdHere(env, config.nerdTerminals);
}

const FALLBACK_CONFIG: Config = {
  icons: "auto",
  nerdTerminals: [],
  updateCheck: true,
  profiles: {},
  agents: {},
  projects: [],
  open: { chromeDir: "" },
  mcpd: { port: 47821, callLog: true },
};

/**
 * Everything the line shows, from the stdin payload and the state dir. Each piece is computed on
 * its own: a bad cache file, a full disk or a broken repository leaves that piece empty and the
 * rest of the line intact. Background workers are queued on `jobs`, not started.
 */
export function collect(payload: unknown, env: NodeJS.ProcessEnv, now = Date.now() / 1000, jobs: Job[] = []): RenderInput {
  const data = sanitize(payload);
  const config = safe(() => loadConfig(env), FALLBACK_CONFIG);
  const p = paths(env);
  const cache = join(p.state, "cache");
  const account = safe(() => profileFromConfigDir(env.CLAUDE_CONFIG_DIR, config, env) ?? "", "");
  const cwd = data.workspace?.current_dir ?? data.cwd ?? "";
  const sid = sessionId(data.session_id);
  const own = data.rate_limits ?? {};
  const input: RenderInput = {
    data,
    now,
    nerd: safe(() => useNerd(config, env), false),
    compact: Number(env.COLUMNS || 120) < 100,
    account,
    pill: safe(() => pillColor(config, account), PILL_DEFAULTS[0]!),
    plan: "",
    limits: account ? own : {},
    chosen: "",
    assigned: "",
    branch: safe(() => gitBranch(cwd), ""),
  };
  if (account) {
    input.limits = safe(() => accountLimits(join(p.usageDir, `${account}.json`), cache, sid, own, now), own);
    input.plan = safe(() => planOf(join(p.planDir, account), now, jobs), "");
    Object.assign(input, safe(() => resolveCached(cwd, config, env, p, cache, now), { chosen: "", assigned: "" }));
    const t = safe(() => turnHistory(cache, sid, data.prompt_id, input.limits.five_hour), undefined);
    if (t !== undefined) input.turnsLeft = t;
    const mine = safe(() => exhaustedUntil(account, env, now), undefined);
    if (mine) input.exhaustedMine = mine;
    const theirs = input.assigned ? safe(() => exhaustedUntil(input.assigned, env, now), undefined) : undefined;
    if (theirs) input.exhaustedAssigned = theirs;
  }
  const cost = safe(() => sessionCost(cache, sid, data.transcript_path, now, jobs), undefined);
  if (cost && cost.unknown.length) {
    // Part of the conversation has no price: Claude Code's own figure, or "$?", never a low total.
    const cc = data.cost?.total_cost_usd;
    if (cc !== undefined) input.cost = { total: cc, sub: 0 };
    else input.costUnknown = true;
  } else if (cost) {
    input.cost = { total: cost.total, sub: cost.sub };
  }
  if (safe(() => gatewayDown(p, cache, now, jobs), false)) input.gatewayDown = true;
  return input;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function planWorker(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  const out = await new Promise<string>((done) =>
    execFile("claude", ["auth", "status", "--json"], { env, timeout: 20_000 }, (_e, stdout) => done(stdout ?? "")),
  );
  let plan: unknown;
  try {
    plan = (JSON.parse(out) as { subscriptionType?: unknown })?.subscriptionType;
  } catch {
    /* not logged in or no answer */
  }
  // An unknown plan leaves the empty file as is: its age schedules the next attempt.
  if (typeof plan === "string" && plan.trim()) writeFileSync(file, plan.trim(), { mode: PRIVATE_FILE_MODE });
}

/** Whether the gateway answers HTTP at all; it refuses this unauthenticated request, which is enough. */
async function healthWorker(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  let port = 0;
  try {
    port = Number.parseInt(readFileSync(paths(env).mcpdPort, "utf8"), 10);
  } catch {
    /* not recorded */
  }
  if (!(port > 0)) port = safe(() => loadConfig(env).mcpd.port, FALLBACK_CONFIG.mcpd.port);
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
    await res.body?.cancel();
    ok = true;
  } catch {
    ok = false;
  }
  save(file, { ok, port, checked_at: Math.trunc(Date.now() / 1000) });
  rmSync(`${file}.lock`, { force: true });
}

export const command: Command = {
  summary: "two-row status line for Claude Code",
  usage: USAGE,
  hidden: false,
  async run(args, io: Io) {
    if (args[0] === "--cost" && args[1] && args[2]) {
      try {
        const { setPriority } = await import("node:os");
        setPriority(10);
      } catch {
        /* not allowed */
      }
      const { computeCost, pruneCache } = await import("../../statusline/cost.js");
      try {
        computeCost(args[1], args[2]);
      } catch {
        /* the next render tries again */
      }
      safe(() => pruneCache(dirname(args[2]!)), 0);
      return 0;
    }
    if (args[0] === "--plan" && args[1]) {
      await planWorker(args[1], io.env).catch(() => undefined);
      return 0;
    }
    if (args[0] === "--health" && args[1]) {
      await healthWorker(args[1], io.env).catch(() => undefined);
      return 0;
    }
    const jobs: Job[] = [];
    let line: string;
    try {
      let payload: unknown = {};
      try {
        payload = JSON.parse((await readStdin()) || "{}");
      } catch {
        /* not JSON: draw what does not depend on it */
      }
      line = render(collect(payload, io.env, Date.now() / 1000, jobs));
    } catch (err) {
      // A minimal line beats an empty one.
      line = `turno statusline: ${(err as Error).name}: ${(err as Error).message}\n`;
    }
    await new Promise<void>((done) => process.stdout.write(line, () => done()));
    for (const job of jobs) safe(job, undefined);
    return 0;
  },
};
