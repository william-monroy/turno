import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRateLimit } from "../src/cli/commands/hook.js";
import { exhaustedUntil } from "../src/core/exhausted.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write(".config/turno/config.toml", 'system = "personal"\n');
});
afterEach(() => sb.cleanup());

describe("hook rate-limit", () => {
  it("marks the session's profile until the reset epoch", () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const env = { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") };
    const r = handleRateLimit(JSON.stringify({ error_type: "rate_limit", error: `Claude AI usage limit reached|${reset}` }), env);
    expect(r).toEqual({ profile: "work", until: reset });
    expect(exhaustedUntil("work", env)).toBe(reset);
  });

  it("uses the system profile for the hub", () => {
    const r = handleRateLimit(JSON.stringify({ error_type: "rate_limit", error: "You've hit your limit · resets 5pm" }), sb.env);
    expect(r?.profile).toBe("personal");
    expect(exhaustedUntil("personal", sb.env)).toBeDefined();
  });

  it("ignores a passing 429 and bad input", () => {
    const env = { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") };
    expect(handleRateLimit(JSON.stringify({ error_type: "rate_limit", error: "Too many requests" }), env)).toBeUndefined();
    expect(handleRateLimit("not json", env)).toBeUndefined();
    expect(handleRateLimit("", env)).toBeUndefined();
    expect(exhaustedUntil("work", env)).toBeUndefined();
  });
});
