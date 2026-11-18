import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustFolders } from "../src/agents/codex.js";
import { main } from "../src/cli/main.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  mkdirSync(join(sb.home, ".codex"));
});

afterEach(() => {
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

const projects = (profile: string) =>
  (
    parse(readFileSync(join(sb.home, `.codex-${profile}/config.toml`), "utf8")) as {
      projects?: Record<string, { trust_level: string }>;
    }
  ).projects ?? {};

describe("Codex trust entries for folder rules", () => {
  it("profile assign trusts the folder in the Codex profile, and keeps comments and existing entries", async () => {
    expect((await run(["profile", "add", "cx", "--agent", "codex"])).code).toBe(0);
    const app = join(sb.home, "code/app");
    const other = join(sb.home, "code/other");
    mkdirSync(app, { recursive: true });
    mkdirSync(other, { recursive: true });
    sb.write(
      ".codex-cx/config.toml",
      `# mine\ncli_auth_credentials_store = "file"\n\n[projects."${other}"]\ntrust_level = "untrusted"\n`,
    );
    const r = await run(["profile", "assign", app, "cx"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\+ trusts ~\/code\/app in Codex/);
    expect(r.out).toMatch(/^Next: turno auto --agent codex in ~\/code\/app opens cx/m);
    expect(projects("cx")[app]).toEqual({ trust_level: "trusted" });
    // A rule for a folder the person marked untrusted does not change their answer.
    expect((await run(["profile", "assign", other, "cx"])).code).toBe(0);
    expect(projects("cx")[other]).toEqual({ trust_level: "untrusted" });
    expect(readFileSync(join(sb.home, ".codex-cx/config.toml"), "utf8")).toMatch(/^# mine$/m);
    // Assigning again writes nothing new.
    expect((await run(["profile", "assign", app, "cx"])).out).not.toMatch(/trusts/);
  });

  it("profile repair writes the entries for rules made before, and undo takes them back", async () => {
    expect((await run(["profile", "add", "cx", "--agent", "codex"])).code).toBe(0);
    const app = join(sb.home, "code/app");
    sb.write(
      ".config/turno/config.toml",
      `[profiles.cx]\nagent = "codex"\n\n[[projects]]\npath = "${app}"\nprofile = "cx"\n`,
    );
    const r = await run(["profile", "repair", "cx"]);
    expect(r.code).toBe(0);
    expect(projects("cx")[app]).toEqual({ trust_level: "trusted" });
    expect((await run(["undo", "last"])).code).toBe(0);
    expect(projects("cx")[app]).toBeUndefined();
  });

  it("trusts the real folder too when the rule's path is a symlink, and quotes odd paths", () => {
    const real = join(sb.home, 'real dir/"quoted"');
    mkdirSync(real, { recursive: true });
    const link = join(sb.home, "link");
    symlinkSync(real, link);
    const dir = join(sb.home, ".codex-cx");
    mkdirSync(dir);
    const written: Record<string, string> = {};
    const writeOwn = (f: string, t: string) => {
      written[f] = t;
    };
    trustFolders({ name: "cx", dir, folders: [link], env: sb.env, out: () => undefined, writeOwn });
    const p = (parse(written[join(dir, "config.toml")]!) as { projects: Record<string, unknown> }).projects;
    expect(Object.keys(p).sort()).toEqual([link, real].sort());
  });

  it("Claude Code profiles get no Codex entries", async () => {
    sb.write(".config/turno/config.toml", "[profiles.work]\n");
    mkdirSync(join(sb.home, ".claude-work"));
    const r = await run(["profile", "assign", sb.home, "work"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/trusts/);
    expect(r.out).toMatch(/^Next: turno auto in ~ opens work/m);
  });
});
