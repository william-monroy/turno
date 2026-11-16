import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Job, collect, command, gitBranch, pillColor } from "../src/cli/commands/statusline.js";
import { parseConfig } from "../src/core/config.js";
import { computeCost, normalizeModel, priceFor, pruneCache, usageCost } from "../src/statusline/cost.js";
import { sanitize } from "../src/statusline/input.js";
import { render, rel, tokens, turnsLeft } from "../src/statusline/render.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const MODELS_FIXTURE = fileURLToPath(new URL("./fixtures/transcript-models.jsonl", import.meta.url));

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("render helpers", () => {
  it("formats tokens and relative times", () => {
    expect(tokens(1_500_000)).toBe("1.5M");
    expect(tokens(2_000_000)).toBe("2M");
    expect(tokens(12_400)).toBe("12k");
    expect(rel(1000 + 3 * 3600 + 5 * 60, 1000)).toBe("3h05m");
    expect(rel(1000 + 50 * 3600, 1000)).toBe("2d2h");
    expect(rel(900, 1000)).toBe("");
  });

  it("estimates turns left from the rise per turn", () => {
    const h: [string, number, number | null][] = [
      ["a", 10, 5000],
      ["b", 12, 5000],
      ["c", 14, 5000],
      ["d", 16, 5000],
    ];
    expect(turnsLeft(h)).toBe(42); // (100 - 16) / 2
    expect(turnsLeft(h.slice(0, 2))).toBeUndefined();
  });
});

describe("render", () => {
  const base = {
    now: 1000,
    nerd: false,
    compact: false,
    account: "work",
    pill: 25,
    plan: "Max",
    limits: { five_hour: { used_percentage: 42, resets_at: 1000 + 7200 }, seven_day: { used_percentage: 90 } },
    chosen: "work",
    assigned: "work",
    branch: "main",
    data: {
      workspace: { current_dir: "/x/acme", repo: { name: "acme" } },
      model: { display_name: "Opus 5.5 (1M context)" },
      context_window: { used_percentage: 30, total_input_tokens: 300_000, context_window_size: 1_000_000 },
    },
  };

  it("draws both rows", () => {
    const [r1, r2] = plain(render(base)).split("\n");
    expect(r1).toContain("work · Max");
    expect(r1).toContain("42%");
    expect(r1).toContain("2h00m");
    expect(r1).toContain("90%");
    expect(r1).toContain("300k/1M");
    expect(r2).toContain("acme");
    expect(r2).toContain("main");
    expect(r2).toContain("Opus 5.5");
    expect(r2).not.toContain("(1M context)");
  });

  it("warns when the folder belongs to another account or a fallback is active", () => {
    expect(plain(render({ ...base, chosen: "personal", assigned: "personal" }))).toContain("personal is back");
    expect(plain(render({ ...base, chosen: "personal", assigned: "other" }))).toContain("project uses personal");
    expect(plain(render({ ...base, chosen: "work", assigned: "personal", exhaustedAssigned: 5000, when: () => "Thu 15:00" }))).toContain(
      "fallback for personal until Thu 15:00",
    );
    expect(plain(render({ ...base, exhaustedMine: 5000, when: () => "Thu 15:00" }))).toContain("exhausted until Thu 15:00");
  });

  it("zeroes a window that already reset", () => {
    const out = plain(render({ ...base, limits: { five_hour: { used_percentage: 99, resets_at: 500 } } }));
    expect(out).toContain(" 0%");
  });
});

describe("pill colors", () => {
  it("uses names, codes and stable defaults", () => {
    const c = parseConfig('[profiles.work]\ncolor = "violet"\n[profiles.home]\ncolor = 33\n[profiles.lab]\n', "c", sb.env);
    expect(pillColor(c, "work")).toBe(91);
    expect(pillColor(c, "home")).toBe(33);
    expect(pillColor(c, "lab")).toBe(91); // third default
  });
});

describe("collect", () => {
  it("publishes fresh limits per account and reads them back in another session", () => {
    const env = { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") };
    mkdirSync(join(sb.home, ".local/state/turno/plan"), { recursive: true });
    writeFileSync(join(sb.home, ".local/state/turno/plan/work"), "max");
    const lim = (pct: number) => ({ five_hour: { used_percentage: pct, resets_at: 99999 } });
    collect({ session_id: "s1", rate_limits: lim(10) }, env, 100); // first sight: not published
    collect({ session_id: "s1", rate_limits: lim(20) }, env, 200); // changed: published
    const usage = JSON.parse(readFileSync(join(sb.home, ".local/state/turno/usage/work.json"), "utf8"));
    expect(usage.rate_limits.five_hour.used_percentage).toBe(20);
    const other = collect({ session_id: "s2", rate_limits: lim(5) }, env, 300);
    expect(other.limits.five_hour?.used_percentage).toBe(20);
    expect(other.plan).toBe("Max");
    expect(other.account).toBe("work");
  });
});

describe("cost", () => {
  it("prices usage and adds subagents incrementally", () => {
    expect(usageCost("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(24);
    expect(usageCost("claude-opus-5-5", { output_tokens: 1e6, speed: "fast" })).toBeCloseTo(40);
    expect(usageCost("unknown", { input_tokens: 1e6 })).toBeUndefined();
    expect(usageCost("<synthetic>", { input_tokens: 0, output_tokens: 0 })).toBe(0);
    const line = (id: string, out: number) =>
      `${JSON.stringify({ type: "assistant", requestId: id, message: { id, model: "claude-sonnet-5-5", usage: { output_tokens: out } } })}\n`;
    const t = sb.write("p/s.jsonl", line("a", 1e6) + line("a", 1e6)); // duplicate block counted once
    sb.write("p/s/subagents/x.jsonl", line("b", 5e5));
    const out = join(sb.home, "cost.json");
    let st = computeCost(t, out);
    expect(st.main).toBeCloseTo(10);
    expect(st.sub).toBeCloseTo(5);
    writeFileSync(t, readFileSync(t, "utf8") + line("c", 1e6) + '{"partial":');
    st = computeCost(t, out);
    expect(st.main).toBeCloseTo(20);
  });
});

describe("prices", () => {
  it("normalizes Bedrock, Vertex and dated ids", () => {
    expect(normalizeModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(normalizeModel("arn:aws:bedrock:us-east-1:123:inference-profile/global.anthropic.claude-opus-4-5-20251101-v1:0")).toBe("claude-opus-4-5");
    expect(normalizeModel("claude-opus-4-1@20250805")).toBe("claude-opus-4-1");
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(normalizeModel("claude-opus-4-20250514")).toBe("claude-opus-4");
    expect(priceFor("claude-opus-4-9")).toBeUndefined(); // no prefix guessing
  });

  it("has a price for every model in the fixture transcript", () => {
    const missing: string[] = [];
    for (const line of readFileSync(MODELS_FIXTURE, "utf8").split("\n").filter(Boolean)) {
      const o = JSON.parse(line) as { message?: { model?: string; usage?: Record<string, number> } };
      const m = o.message;
      if (!m?.usage || !m.model) continue;
      if (Object.values(m.usage).every((n) => !n)) continue; // synthetic records bill nothing
      if (!priceFor(m.model)) missing.push(m.model);
    }
    expect(missing).toEqual([]);
    const st = computeCost(MODELS_FIXTURE, join(sb.home, "fx-cost.json"));
    expect(st.unknown).toEqual([]);
    expect(st.total).toBeGreaterThan(0);
  });

  it("prices the legacy models and the long-prompt tier of Haiku 5.5", () => {
    expect(usageCost("claude-opus-4-1-20250805", { input_tokens: 1e6 })).toBeCloseTo(15);
    expect(usageCost("claude-sonnet-4-5@20250929", { output_tokens: 1e6 })).toBeCloseTo(15);
    expect(usageCost("claude-haiku-5-5", { input_tokens: 50_000 })).toBeCloseTo(0.005);
    expect(usageCost("claude-haiku-5-5", { input_tokens: 200_000 })).toBeCloseTo(0.1);
  });

  it("never shows a low cost when a model has no price", () => {
    const line = (id: string, model: string) =>
      `${JSON.stringify({ type: "assistant", requestId: id, message: { id, model, usage: { output_tokens: 1e6 } } })}\n`;
    const t = sb.write("p/u.jsonl", line("a", "claude-sonnet-5-5") + line("b", "claude-future-9"));
    const env = { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") };
    const out = join(sb.home, ".local/state/turno/cache/cost-s1.json");
    const st = computeCost(t, out);
    expect(st.unknown).toEqual(["claude-future-9"]);
    const withCc = collect({ session_id: "s1", transcript_path: t, cost: { total_cost_usd: 1.23 } }, env, st.updated_at);
    expect(withCc.cost).toEqual({ total: 1.23, sub: 0 });
    expect(plain(render(withCc))).toContain("$1.23");
    const without = collect({ session_id: "s1", transcript_path: t }, env, st.updated_at);
    expect(without.cost).toBeUndefined();
    expect(plain(render(without))).toContain("$?");
    expect(plain(render(without))).not.toContain("$0.00");
  });

  it("ignores a cost state from an older version", () => {
    sb.write(".local/state/turno/cache/cost-s1.json", JSON.stringify({ files: {}, total: 0, sub: 0, updated_at: 100 }));
    const jobs: Job[] = [];
    const r = collect({ session_id: "s1", transcript_path: "/nope.jsonl", cost: { total_cost_usd: 2 } }, sb.env, 110, jobs);
    expect(r.cost).toBeUndefined();
    expect(plain(render(r))).toContain("$2.00…");
    expect(jobs).toHaveLength(1); // recomputed in the background
  });
});

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("status line robustness", () => {
  const work = () => ({ ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") });
  const rows = (s: string) => s.split("\n").filter(Boolean).length;

  it("draws two rows for null, scalar and cross-typed payloads", () => {
    const odd: unknown[] = [
      null,
      42,
      "text",
      [],
      [1, 2],
      { workspace: null, model: null, cost: null, context_window: null, prompt_cache: null, rate_limits: null },
      { workspace: { current_dir: 5, repo: "x" }, model: { display_name: 7 }, effort: { level: {} } },
      { rate_limits: { five_hour: { used_percentage: "50", resets_at: "soon" }, seven_day: [] } },
      { cost: { total_cost_usd: "1.5", total_lines_added: null }, context_window: { used_percentage: "9" } },
      { session_id: "../../escape", prompt_id: 3, transcript_path: {} },
      { session_id: null, cwd: null, prompt_cache: { caching_observed: "yes", expires_at: "later" } },
    ];
    const values: unknown[] = [null, undefined, 0, -1, 1e308, Number.NaN, "", "x", "../..", true, [], [null], {}, { a: 1 }];
    const keys = ["session_id", "prompt_id", "cwd", "transcript_path", "workspace", "model", "effort", "cost", "context_window", "prompt_cache", "rate_limits"];
    const r = rng(7);
    const any = (depth: number): unknown => {
      if (depth > 0 && r() < 0.4) {
        const o: Record<string, unknown> = {};
        for (const k of ["current_dir", "repo", "name", "display_name", "level", "total_cost_usd", "used_percentage", "resets_at", "five_hour", "seven_day", "warm", "expires_at"]) {
          if (r() < 0.3) o[k] = any(depth - 1);
        }
        return o;
      }
      return values[Math.floor(r() * values.length)];
    };
    for (let n = 0; n < 150; n++) {
      const o: Record<string, unknown> = {};
      for (const k of keys) if (r() < 0.6) o[k] = any(2);
      odd.push(o);
    }
    for (const payload of odd) {
      const out = render(collect(payload, work(), 1000));
      expect(rows(out), JSON.stringify(payload)).toBe(2);
      expect(out).not.toContain("NaN");
      expect(out).not.toContain("turno statusline:");
    }
    const written = readdirSync(join(sb.home, ".local"), { recursive: true }).map(String);
    expect(written.filter((f) => f.includes("escape"))).toEqual([]);
  });

  it("keeps only typed fields of the payload", () => {
    expect(sanitize(null)).toEqual({});
    expect(sanitize({ session_id: "../x", rate_limits: { five_hour: { used_percentage: "5", resets_at: 9 } } })).toEqual({
      rate_limits: { five_hour: { resets_at: 9 } },
    });
  });

  it("survives cache files of the wrong shape", () => {
    const env = work();
    const st = ".local/state/turno";
    sb.write(`${st}/cache/turns-s1.json`, "{}");
    sb.write(`${st}/cache/rl-s1.json`, "[1]");
    sb.write(`${st}/cache/cost-s1.json`, '{"v":2,"total":"x"}');
    sb.write(`${st}/usage/work.json`, '{"rate_limits":{"five_hour":{"used_percentage":"80"}},"updated_at":"now"}');
    sb.write(`${st}/exhausted/work`, "garbage");
    mkdirSync(join(sb.home, `${st}/plan/work`), { recursive: true }); // a folder where a file should be
    const payload = { session_id: "s1", prompt_id: "p1", transcript_path: "/x.jsonl", rate_limits: { five_hour: { used_percentage: 30, resets_at: 9000 } } };
    const r = collect(payload, env, 1000);
    expect(r.limits.five_hour?.used_percentage).toBe(30);
    expect(rows(render(r))).toBe(2);
    expect(JSON.parse(readFileSync(join(sb.home, `${st}/cache/turns-s1.json`), "utf8"))).toEqual([["p1", 30, 9000]]);
  });

  it("survives a state dir it cannot write", () => {
    const blocker = sb.write("blocker", "a file, not a folder");
    const env = { ...work(), TURNO_STATE_DIR: join(blocker, "state") };
    const jobs: Job[] = [];
    const r = collect({ session_id: "s1", prompt_id: "p", transcript_path: "/x.jsonl", rate_limits: { five_hour: { used_percentage: 3 } } }, env, 1000, jobs);
    expect(r.account).toBe("work");
    expect(rows(render(r))).toBe(2);
    expect(r.plan).toBe("");
    for (const job of jobs) job(); // the workers cannot lock either: nothing starts
  });
});

describe("plan", () => {
  const env = () => ({ ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") });
  const planFile = () => join(sb.home, ".local/state/turno/plan/work");

  it("asks once, then again after ten minutes while the plan is unknown", () => {
    const now = Date.now() / 1000;
    const jobs: Job[] = [];
    collect({}, env(), now, jobs);
    expect(jobs).toHaveLength(1);
    expect(readFileSync(planFile(), "utf8")).toBe("");
    collect({}, env(), now + 5, jobs);
    expect(jobs).toHaveLength(1); // a fresh attempt is running
    utimesSync(planFile(), now - 700, now - 700);
    collect({}, env(), now, jobs);
    expect(jobs).toHaveLength(2);
  });

  it("does not record an empty plan", async () => {
    fakeCommand(sb, "claude", 'echo \'{"loggedIn":false}\'');
    sb.write(".local/state/turno/plan/work", "");
    const old = Date.now() / 1000 - 3600;
    utimesSync(planFile(), old, old);
    await command.run(["--plan", planFile()], fakeIo(sb.env));
    expect(readFileSync(planFile(), "utf8")).toBe("");
    expect(statSync(planFile()).mtimeMs / 1000).toBeCloseTo(old, 0);
    fakeCommand(sb, "claude", 'echo \'{"loggedIn":true,"subscriptionType":"max"}\'');
    await command.run(["--plan", planFile()], fakeIo(sb.env));
    expect(collect({}, env()).plan).toBe("Max");
  });
});

describe("branch", () => {
  it("reads HEAD without git, through worktree links and detached heads", () => {
    const repo = join(sb.home, "repo");
    sb.write("repo/.git/HEAD", "ref: refs/heads/feature/x\n");
    mkdirSync(join(repo, "src/deep"), { recursive: true });
    expect(gitBranch(join(repo, "src/deep"))).toBe("feature/x");
    sb.write("repo/.git/worktrees/wt/HEAD", "0123456789abcdef0123456789abcdef01234567\n");
    sb.write("wt/.git", `gitdir: ${join(repo, ".git/worktrees/wt")}\n`);
    expect(gitBranch(join(sb.home, "wt"))).toBe("0123456");
    sb.write("rel/.git", "gitdir: ../repo/.git\n");
    expect(gitBranch(join(sb.home, "rel"))).toBe("feature/x");
    expect(gitBranch(join(sb.home, "missing"))).toBe("");
    mkdirSync(join(sb.home, "plain"));
    expect(gitBranch(join(sb.home, "plain"))).toBe("");
  });
});

describe("cache", () => {
  const env = () => ({ ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") });
  const cache = () => join(sb.home, ".local/state/turno/cache");

  it("keeps folders apart that the old key mixed up", () => {
    collect({ cwd: "/a/b-c" }, env(), 1000);
    collect({ cwd: "/a/b/c" }, env(), 1000);
    expect(readdirSync(cache()).filter((f) => f.startsWith("resolve-"))).toHaveLength(2);
  });

  it("rewrites the turn history only when it changes", () => {
    const payload = { session_id: "s1", prompt_id: "p1", rate_limits: { five_hour: { used_percentage: 10, resets_at: 9000 } } };
    collect(payload, env(), 1000);
    const file = join(cache(), "turns-s1.json");
    utimesSync(file, 500, 500);
    collect(payload, env(), 1001);
    expect(statSync(file).mtimeMs / 1000).toBe(500);
    collect({ ...payload, rate_limits: { five_hour: { used_percentage: 11, resets_at: 9000 } } }, env(), 1002);
    expect(statSync(file).mtimeMs / 1000).not.toBe(500);
  });

  it("prunes files older than a week, at most once a day", () => {
    const dir = cache();
    const now = Date.now() / 1000;
    const old = sb.write(".local/state/turno/cache/cost-old.json", "{}");
    utimesSync(old, now - 8 * 86_400, now - 8 * 86_400);
    const fresh = sb.write(".local/state/turno/cache/cost-new.json", "{}");
    expect(pruneCache(dir, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    const again = sb.write(".local/state/turno/cache/turns-old.json", "[]");
    utimesSync(again, now - 8 * 86_400, now - 8 * 86_400);
    expect(pruneCache(dir, now + 60)).toBe(0); // pruned less than a day ago
  });
});

describe("gateway marker", () => {
  const st = ".local/state/turno";

  it("shows when the synced gateway did not answer", () => {
    const now = 10_000;
    const jobs: Job[] = [];
    expect(collect({}, sb.env, now, jobs).gatewayDown).toBeUndefined(); // never synced: no check at all
    expect(jobs).toHaveLength(0);
    sb.write(`${st}/mcp-managed.json`, JSON.stringify({ "/x/.claude.json": ["fx"] }));
    collect({}, sb.env, now, jobs);
    expect(jobs).toHaveLength(1);
    sb.write(`${st}/cache/mcpd-health.json`, JSON.stringify({ ok: false, checked_at: now - 10 }));
    const r = collect({}, sb.env, now);
    expect(r.gatewayDown).toBe(true);
    expect(plain(render(r))).toContain("mcpd down");
    sb.write(`${st}/cache/mcpd-health.json`, JSON.stringify({ ok: true, checked_at: now - 10 }));
    expect(collect({}, sb.env, now).gatewayDown).toBeUndefined();
  });

  it("checks the recorded port", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = (server.address() as AddressInfo).port;
      sb.write(`${st}/mcpd.port`, `${port}\n`);
      const file = join(sb.home, `${st}/cache/mcpd-health.json`);
      await command.run(["--health", file], fakeIo(sb.env));
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ ok: true, port });
      await new Promise<void>((done) => server.close(() => done()));
      await command.run(["--health", file], fakeIo(sb.env));
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ ok: false, port });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
