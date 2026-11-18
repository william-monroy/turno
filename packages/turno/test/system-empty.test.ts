import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubProfileOf } from "../src/cli/commands/mcp.js";
import { main } from "../src/cli/main.js";
import { loadConfig } from "../src/core/config.js";
import { profileFromConfigDir } from "../src/core/profiles.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.write(".config/turno/config.toml", 'system = ""\n[profiles.work]\n');
  sb.write(".claude-work/.claude.json", "{}");
});

afterEach(() => {
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe('system = "" (no default account)', () => {
  it("is not a profile: the hub belongs to nobody, and mcp sync uses the name default", () => {
    const config = loadConfig(sb.env);
    expect(config.system).toBe("");
    expect(profileFromConfigDir(undefined, config, sb.env)).toBeUndefined();
    expect(hubProfileOf(config)).toBe("default");
    expect(hubProfileOf({})).toBe("default");
    expect(hubProfileOf({ system: "work" })).toBe("work");
  });

  it("profile which says no profile instead of plain claude, and --check exits 3", async () => {
    const r = await run(["profile", "which", sb.home]);
    expect(r.out).toMatch(/using now: no profile: system = ""/);
    expect(r.out).not.toMatch(/plain claude/);
    expect((await run(["profile", "which", sb.home, "--check"])).code).toBe(3);
  });

  it("status shows no profile for the folder", async () => {
    const r = await run(["status"]);
    expect(r.out).toMatch(/no profile/);
    expect(r.out).not.toMatch(/plain claude/);
  });

  it("turno auto exits 3 and names the fix", async () => {
    const r = await run(["auto"]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/system = "" says there is no default account.*turno profile assign/);
  });
});
