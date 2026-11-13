import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { paths } from "../../core/paths.js";
import { profileFromConfigDir } from "../../core/profiles.js";
import { resolveProfile } from "../../core/resolve.js";
import { nerdHere } from "../../ui/terminal-id.js";
import { NAMED_COLORS, PILL_DEFAULTS, type RenderInput, type StatusData, type Window, render, turnsLeft } from "../../statusline/render.js";
import type { Command, Io } from "../io.js";

const USAGE = `Usage:
  turno statusline        render the status line from the JSON Claude Code sends on stdin

Set it in settings.json:
  "statusLine": { "type": "command", "command": "turno statusline" }`;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
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

/**
 * The account's windows, the freshest any session has seen. Each session carries the values of
 * its own last response, so an idle one has stale data. A session only publishes when its values
 * change (a new response), so a quiet session redrawing never overwrites fresh data from another.
 */
function accountLimits(
  usageFile: string,
  cache: string,
  sessionId: string | undefined,
  limits: { five_hour?: Window; seven_day?: Window },
  now: number,
): { five_hour?: Window; seven_day?: Window } {
  let changedAt = 0;
  if (Object.keys(limits).length && sessionId) {
    const sig = stableJson(limits);
    const seenFile = join(cache, `rl-${sessionId}.json`);
    const seen = readJson<{ sig?: string; changed_at?: number }>(seenFile) ?? {};
    if (seen.sig !== sig) {
      changedAt = "sig" in seen ? now : 0; // the first time we cannot tell whether the data is new
      writeJson(seenFile, { sig, changed_at: changedAt });
      if (changedAt) writeJson(usageFile, { rate_limits: limits, updated_at: Math.trunc(now) });
    } else {
      changedAt = seen.changed_at ?? 0;
    }
  }
  const shared = readJson<{ rate_limits?: typeof limits; updated_at?: number }>(usageFile);
  if (shared?.rate_limits && (shared.updated_at ?? 0) > changedAt) return shared.rate_limits;
  return limits;
}

const PLAN_NAMES: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };

function planOf(file: string): string {
  let p: string;
  try {
    p = readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ""); // only one render asks for it
    background(["--plan", file]);
    return "";
  }
  return PLAN_NAMES[p] ?? p;
}

function resolveCached(cwd: string, config: Config, env: NodeJS.ProcessEnv, cache: string, now: number): { chosen: string; assigned: string } {
  if (!cwd) return { chosen: "", assigned: "" };
  const file = join(cache, `resolve-${cwd.replace(/[^A-Za-z0-9]/g, "-").slice(-120)}`);
  try {
    if (now - statSync(file).mtimeMs / 1000 < 120) {
      const [chosen = "", assigned = ""] = readFileSync(file, "utf8").split("\x1f");
      return { chosen, assigned };
    }
  } catch {
    /* compute */
  }
  const r = resolveProfile(cwd, config, env);
  mkdirSync(cache, { recursive: true });
  writeFileSync(file, `${r.chosen}\x1f${r.assigned}`);
  return { chosen: r.chosen, assigned: r.assigned };
}

function turnHistory(cache: string, sessionId: string | undefined, promptId: string | undefined, five: Window | undefined): number | undefined {
  if (!sessionId || !five || five.used_percentage === undefined) return undefined;
  const file = join(cache, `turns-${sessionId}.json`);
  const hist = readJson<[string, number, number | null][]>(file) ?? [];
  if (promptId) {
    const entry: [string, number, number | null] = [promptId, five.used_percentage, five.resets_at ?? null];
    if (hist.length && hist[hist.length - 1]![0] === promptId) hist[hist.length - 1] = entry;
    else hist.push(entry);
    writeJson(file, hist.slice(-12));
  }
  return turnsLeft(hist);
}

function gitBranch(cwd: string): string {
  if (!cwd || !existsSync(cwd)) return "";
  const git = (args: string[]) => {
    try {
      return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return git(["branch", "--show-current"]) || git(["rev-parse", "--short", "HEAD"]); // detached HEAD: short commit
}

function sessionCost(cache: string, sessionId: string | undefined, transcript: string | undefined, now: number): { total: number; sub: number } | undefined {
  if (!sessionId || !transcript) return undefined;
  const out = join(cache, `cost-${sessionId}.json`);
  const data = readJson<{ total: number; sub: number; updated_at: number }>(out);
  const stale = !data || now - (data.updated_at ?? 0) > 60;
  const lock = `${out}.lock`;
  let locked = false;
  try {
    locked = now - statSync(lock).mtimeMs / 1000 < 600;
  } catch {
    /* no lock */
  }
  if (stale && !locked) {
    mkdirSync(cache, { recursive: true });
    closeSync(openSync(lock, "w"));
    background(["--cost", transcript, out]);
  }
  return data ? { total: data.total, sub: data.sub } : undefined;
}

export function useNerd(config: Config, env: NodeJS.ProcessEnv): boolean {
  if (config.icons === "nerd") return true;
  if (config.icons === "unicode") return false;
  return nerdHere(env, config.nerdTerminals);
}

export function collect(data: StatusData, env: NodeJS.ProcessEnv, now = Date.now() / 1000): RenderInput {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch {
    config = { icons: "auto", nerdTerminals: [], updateCheck: true, profiles: {}, agents: {}, projects: [], open: { chromeDir: "" }, mcpd: { port: 47821 } };
  }
  const p = paths(env);
  const cache = join(p.state, "cache");
  const account = profileFromConfigDir(env.CLAUDE_CONFIG_DIR, config, env) ?? "";
  const cwd = data.workspace?.current_dir ?? data.cwd ?? "";
  const limits = account ? accountLimits(join(p.usageDir, `${account}.json`), cache, data.session_id, data.rate_limits ?? {}, now) : {};
  const { chosen, assigned } = account ? resolveCached(cwd, config, env, cache, now) : { chosen: "", assigned: "" };
  const input: RenderInput = {
    data,
    now,
    nerd: useNerd(config, env),
    compact: Number(env.COLUMNS || 120) < 100,
    account,
    pill: pillColor(config, account),
    plan: account ? planOf(join(p.planDir, account)) : "",
    limits,
    chosen,
    assigned,
    branch: gitBranch(cwd),
  };
  if (account) {
    const t = turnHistory(cache, data.session_id, data.prompt_id, limits.five_hour);
    if (t !== undefined) input.turnsLeft = t;
    const mine = exhaustedUntil(account, env, now);
    if (mine) input.exhaustedMine = mine;
    const theirs = assigned ? exhaustedUntil(assigned, env, now) : undefined;
    if (theirs) input.exhaustedAssigned = theirs;
  }
  const cost = sessionCost(cache, data.session_id, data.transcript_path, now);
  if (cost) input.cost = cost;
  return input;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function planWorker(file: string): Promise<void> {
  const out = await new Promise<string>((resolve) =>
    execFile("claude", ["auth", "status", "--json"], { timeout: 20_000 }, (_e, stdout) => resolve(stdout ?? "")),
  );
  try {
    const plan = (JSON.parse(out) as { subscriptionType?: string }).subscriptionType ?? "";
    writeFileSync(file, plan);
  } catch {
    /* leave it empty; the next missing-file render retries */
  }
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
      const { computeCost } = await import("../../statusline/cost.js");
      computeCost(args[1], args[2]);
      return 0;
    }
    if (args[0] === "--plan" && args[1]) {
      await planWorker(args[1]);
      return 0;
    }
    try {
      const raw = await readStdin();
      const data = JSON.parse(raw || "{}") as StatusData;
      process.stdout.write(render(collect(data, io.env)));
    } catch (err) {
      // A minimal line beats an empty one.
      process.stdout.write(`turno statusline: ${(err as Error).name}: ${(err as Error).message}\n`);
    }
    return 0;
  },
};
