import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.env.PATH = `${join(sb.home, ".local/bin")}:/usr/bin:/bin`;
  sb.env.TURNO_NO_UPDATE_CHECK = "1";
  fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
  mkdirSync(join(sb.home, ".claude"), { recursive: true });
});
afterEach(() => sb.cleanup());

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const io = fakeIo(sb.env);
  const code = await main(args, io);
  return { code, out: [...io.lines, ...io.errors].join("\n") };
}

function profiles(...names: string[]): void {
  for (const name of names) {
    mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
    writeLauncher(name, sb.env);
  }
  sb.write(".config/turno/config.toml", names.map((n) => `[profiles.${n}]\n`).join("\n"));
}

describe("bare turno", () => {
  it("shows the help on a machine turno has not set up", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Start here: turno init");
    expect(r.out).not.toMatch(/^Next /m);
  });

  it("shows the status screen once turno is set up, with the next step and where the help is", async () => {
    profiles("work");
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Here\n {2}claude /m);
    expect(r.out).toMatch(/^Profiles\n.*\n {2}work /m);
    expect(r.out).toMatch(/^Next {2}turno ui install\n {6}optional: the status line/m);
    expect(r.out).toContain("turno help lists every command.");
    expect(r.out).not.toContain("Start here");
  });

  it("--help still shows the help", async () => {
    profiles("work");
    expect((await run(["--help"])).out).toContain("Start here: turno init");
  });
});

describe("next step", () => {
  it("names the first thing to fix, in order", async () => {
    sb.write(".config/turno/config.toml", "[profiles.work]\n");
    let r = await run(["status"]);
    expect(r.out).toMatch(/^Next {2}turno profile repair work\n {6}profile work has no folder or launcher yet$/m);

    profiles("work");
    sb.write(".config/turno/mcp.toml", '[server.docs]\ncommand = "docs-mcp"\nscope = "shared"\n');
    r = await run(["status"]);
    expect(r.out).toMatch(/^Next {2}turno mcp daemon start\n {6}mcp\.toml has 1 server and the gateway is not running$/m);
  });

  it("is part of status --json, and null when nothing is left", async () => {
    profiles("work");
    const j = JSON.parse((await run(["status", "--json"])).out);
    expect(j.next).toEqual({ command: "turno ui install", why: "optional: the status line with account, usage and gateway" });
  });
});
