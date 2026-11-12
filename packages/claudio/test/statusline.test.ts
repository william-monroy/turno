import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect, pillColor } from "../src/cli/commands/statusline.js";
import { parseConfig } from "../src/core/config.js";
import { computeCost, usageCost } from "../src/statusline/cost.js";
import { render, rel, tokens, turnsLeft } from "../src/statusline/render.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

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
    mkdirSync(join(sb.home, ".local/state/claudio/plan"), { recursive: true });
    writeFileSync(join(sb.home, ".local/state/claudio/plan/work"), "max");
    const lim = (pct: number) => ({ five_hour: { used_percentage: pct, resets_at: 99999 } });
    collect({ session_id: "s1", rate_limits: lim(10) }, env, 100); // first sight: not published
    collect({ session_id: "s1", rate_limits: lim(20) }, env, 200); // changed: published
    const usage = JSON.parse(readFileSync(join(sb.home, ".local/state/claudio/usage/work.json"), "utf8"));
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
    expect(usageCost("unknown", { input_tokens: 1e6 })).toBe(0);
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
