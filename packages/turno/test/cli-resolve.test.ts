import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as exhausted, parseLocalDateTime } from "../src/cli/commands/exhausted.js";
import { command as resolve } from "../src/cli/commands/resolve.js";
import { command as which } from "../src/cli/commands/which.js";
import { exhaustedUntil } from "../src/core/exhausted.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = sandbox();
  dir = join(sb.home, "code/acme/sub");
  mkdirSync(dir, { recursive: true });
  sb.write(
    ".config/turno/config.toml",
    'default = "personal"\nfallback = "personal"\n[[projects]]\npath = "~/code/acme"\nprofile = "work"\n',
  );
  sb.write(".local/bin/claude-work", "#!/bin/sh\n", 0o755);
});
afterEach(() => sb.cleanup());

describe("resolve", () => {
  it("prints chosen, assigned, reason and note separated by \\x1f", async () => {
    const io = fakeIo(sb.env);
    expect(await resolve.run([dir], io)).toBe(0);
    expect(io.lines).toEqual(["work\x1fwork\x1fproject ~/code/acme\x1f"]);
  });

  it("uses the default for a folder without a rule, and --json", async () => {
    const io = fakeIo(sb.env);
    await resolve.run([sb.home, "--json"], io);
    expect(JSON.parse(io.lines[0]!)).toEqual({
      schemaVersion: 1,
      chosen: "personal",
      assigned: "personal",
      reason: "folder without a rule",
      note: "",
    });
  });

  it("switches to the fallback when the profile is exhausted", async () => {
    await exhausted.run(["work"], fakeIo(sb.env));
    expect(exhaustedUntil("work", sb.env)).toBeGreaterThan(Date.now() / 1000 + 4 * 3600);
    const io = fakeIo(sb.env);
    await resolve.run([dir], io);
    const [chosen, assigned, , note] = io.lines[0]!.split("\x1f");
    expect([chosen, assigned]).toEqual(["personal", "work"]);
    expect(note).toMatch(/^exhausted until /);

    const w = fakeIo(sb.env);
    await which.run([dir], w);
    expect(w.lines).toEqual([
      "~/code/acme/sub",
      "  assigned: work (project ~/code/acme)",
      `  using now: personal (work ${note})`,
    ]);
  });

  it("parses the until date and rejects bad input", async () => {
    expect(parseLocalDateTime("2026-12-01 09:30")).toBe(new Date(2026, 11, 1, 9, 30).getTime() / 1000);
    expect(parseLocalDateTime("2026-13-01 09:30")).toBeUndefined();
    await expect(exhausted.run(["work", "until", "tomorrow"], fakeIo(sb.env))).rejects.toThrow(/invalid date/);
    await expect(exhausted.run(["nobody"], fakeIo(sb.env))).rejects.toThrow(/usage/);
  });
});
