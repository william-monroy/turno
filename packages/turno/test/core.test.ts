import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/core/config.js";
import { markExhausted } from "../src/core/exhausted.js";
import { listProfiles, profileFromConfigDir } from "../src/core/profiles.js";
import { isUsageLimit, resetTime } from "../src/core/ratelimit.js";
import { resolveProfile } from "../src/core/resolve.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("config", () => {
  it("applies defaults for an empty file", () => {
    const c = parseConfig("", "x", sb.env);
    expect(c.icons).toBe("auto");
    expect(c.mcpd.port).toBe(47821);
    expect(c.projects).toEqual([]);
  });

  it("parses profiles and projects and expands ~", () => {
    const c = parseConfig(
      `system = "personal"\ndefault = "personal"\nfallback = "work"\n[profiles.work]\nbrowser = "default"\ncolor = 25\n[[projects]]\npath = "~/code/acme"\nprofile = "work"\n`,
      "x",
      sb.env,
    );
    expect(c.profiles.work).toEqual({ browser: "default", color: 25 });
    expect(c.projects[0]).toEqual({ path: join(sb.home, "code/acme"), profile: "work" });
    expect(c.fallback).toBe("work");
  });

  it("rejects bad values", () => {
    expect(() => parseConfig(`icons = "emoji"`, "x", sb.env)).toThrow(ConfigError);
    expect(() => parseConfig(`[profiles."Bad Name"]`, "x", sb.env)).toThrow(/invalid profile name/);
    expect(() => parseConfig(`[mcpd]\nport = 80`, "x", sb.env)).toThrow(/port/);
  });
});

describe("profiles", () => {
  it("counts a folder only when its launcher exists", () => {
    mkdirSync(join(sb.home, ".claude-work"));
    mkdirSync(join(sb.home, ".claude-shared-skills"));
    sb.write(".local/bin/claude-work", "#!/bin/sh\n");
    const c = parseConfig(`[profiles.declared]`, "x", sb.env);
    expect(listProfiles(c, sb.env)).toEqual(["declared", "work"]);
  });

  it("maps a config dir to its profile and the hub to the system profile", () => {
    const c = parseConfig(`system = "personal"`, "x", sb.env);
    expect(profileFromConfigDir(join(sb.home, ".claude-work/"), c, sb.env)).toBe("work");
    expect(profileFromConfigDir(undefined, c, sb.env)).toBe("personal");
    expect(profileFromConfigDir(join(sb.home, ".claude"), c, sb.env)).toBe("personal");
    expect(profileFromConfigDir("/elsewhere/cfg", c, sb.env)).toBeUndefined();
  });
});

describe("resolve", () => {
  const cfg = () =>
    parseConfig(
      `default = "personal"\nfallback = "spare"\n[[projects]]\npath = "~/code"\nprofile = "work"\n[[projects]]\npath = "~/code/side"\nprofile = "side"\n`,
      "x",
      sb.env,
    );

  it("picks the longest matching rule", () => {
    mkdirSync(join(sb.home, "code/side/app"), { recursive: true });
    const r = resolveProfile(join(sb.home, "code/side/app"), cfg(), sb.env, [join(sb.home, "code/side/app")]);
    expect(r).toMatchObject({ chosen: "side", assigned: "side", note: "" });
    expect(r.reason).toBe("project ~/code/side");
  });

  it("uses the main repository of a worktree", () => {
    const r = resolveProfile("/tmp/wt", cfg(), sb.env, ["/tmp/wt", join(sb.home, "code/x")]);
    expect(r.chosen).toBe("work");
  });

  it("falls back to the default and to the fallback when exhausted", () => {
    expect(resolveProfile("/nowhere", cfg(), sb.env, ["/nowhere"])).toMatchObject({ chosen: "personal", reason: "folder without a rule" });
    markExhausted("personal", Date.now() / 1000 + 600, sb.env);
    const r = resolveProfile("/nowhere", cfg(), sb.env, ["/nowhere"]);
    expect(r.chosen).toBe("spare");
    expect(r.assigned).toBe("personal");
    expect(r.note).toMatch(/^exhausted until/);
  });

  it("keeps the assigned profile when the fallback is exhausted too", () => {
    markExhausted("personal", Date.now() / 1000 + 600, sb.env);
    markExhausted("spare", Date.now() / 1000 + 600, sb.env);
    expect(resolveProfile("/nowhere", cfg(), sb.env, ["/nowhere"]).chosen).toBe("personal");
  });

  it("ignores and removes expired marks", () => {
    markExhausted("personal", Date.now() / 1000 - 10, sb.env);
    expect(resolveProfile("/nowhere", cfg(), sb.env, ["/nowhere"]).chosen).toBe("personal");
  });
});

describe("rate limit hook parsing", () => {
  const now = new Date(2026, 10, 12, 10, 0, 0); // Nov 12 2026 10:00 local

  it("only reacts to usage limits", () => {
    expect(isUsageLimit({ error_type: "rate_limit", error: "Claude usage limit reached" })).toBe(true);
    expect(isUsageLimit({ error_type: "rate_limit", error: "429 too many requests" })).toBe(false);
    expect(isUsageLimit({ error_type: "overloaded", error: "usage limit" })).toBe(false);
  });

  it("reads an epoch suffix", () => {
    const t = now.getTime() / 1000 + 7200;
    expect(resetTime(`Claude AI usage limit reached|${Math.floor(t)}`, now)).toBe(Math.floor(t));
  });

  it("reads a time today, or tomorrow when already past", () => {
    expect(new Date(resetTime("limit resets 5pm", now) * 1000).getHours()).toBe(17);
    const past = new Date(resetTime("limit resets at 9:30 am", now) * 1000);
    expect([past.getDate(), past.getHours(), past.getMinutes()]).toEqual([13, 9, 30]);
  });

  it("reads a date and time", () => {
    const d = new Date(resetTime("Your limit resets on Nov 15, 3pm", now) * 1000);
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([10, 15, 15]);
  });

  it("defaults to one hour", () => {
    expect(resetTime("usage limit reached", now)).toBe(now.getTime() / 1000 + 3600);
  });
});
