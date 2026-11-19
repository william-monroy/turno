import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSecretStore } from "../helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";

/**
 * The `turno-browser` program, run from dist/ in a throwaway HOME: the identity commands without
 * turno-cli. The secret store is the file-backed fake, and no command here starts Chrome.
 */

const BIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  fakeSecretStore(sb);
});
afterEach(() => sb.cleanup());

function run(args: string[], input = "") {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...sb.env, TURNO_NO_INPUT: "1" },
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);

describe("turno-browser", () => {
  it("is a bin of the package, and prints its version and its help by section", () => {
    expect(PKG.bin["turno-browser"]).toBe("dist/cli/main.js");
    expect(run(["--version"])).toMatchObject({ code: 0, out: `turno-browser ${PKG.version}\n` });
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    for (const section of ["Identities", "Sign-ins and sessions", "Flows and recordings", "Checks"])
      expect(help.out).toContain(section);
    expect(help.out).toMatch(/^ {2}add +create an identity/m);
    expect(help.out).toContain("turno-browser-mcp --identity <id>");
    expect(help.out).not.toMatch(/detector|fingerprint|patchright/i);
    expect(run([]).out).toBe(help.out);
    expect(run(["help", "add"]).out).toContain("turno-browser add <id>");
  });

  it("adds an identity and prints how to connect an agent instead of an mcp.toml block", () => {
    const r = run(["add", "school", "--languages", "es-MX,es,en"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/identity "school" ready at ~\/\.local\/share\/turno\/browser\/identities\/school/);
    expect(r.out).toContain("turno-browser setup claude-code --identity school");
    expect(r.out).toContain("turno-browser-mcp --identity school");
    expect(r.out).toContain("turno-browser login school");
    expect(r.out).not.toMatch(/mcp\.toml|turno mcp sync|turno identity/);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).languages).toEqual(["es-MX", "es", "en"]);
  });

  it("lists identities, as text and as JSON", () => {
    expect(run(["list"]).out).toMatch(/No browser identities yet\. Create one with `turno-browser add <id>`\./);
    run(["add", "school"]);
    const text = run(["list"]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^school +free/m);
    expect(JSON.parse(run(["list", "--json"]).out)).toEqual([
      { schemaVersion: 1, id: "school", inUse: false, dir: "~/.local/share/turno/browser/identities/school" },
    ]);
  });

  it("sets and shows identity.json, with turno-browser in its hints", () => {
    run(["add", "school"]);
    const set = run(["set", "school", "--timezone", "Europe/Madrid", "--sharing", "tabs"]);
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/updated identity\.json of "school"/);
    // On its own there is no mcp.toml to change after --sharing.
    expect(set.out).not.toMatch(/mcp\.toml|turno mcp sync/);
    const show = run(["show", "school", "--json"]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out).settings).toMatchObject({ timezone: "Europe/Madrid", sharing: "tabs" });
    expect(run(["show", "nobody"])).toMatchObject({ code: 2 });
    expect(run(["show", "nobody"]).err).toBe(
      'turno-browser: identity "nobody" does not exist (turno-browser add nobody)\n',
    );
    expect(run(["set", "--help"]).out).toContain("(turno-browser doctor says how)");
  });

  it("lists a vault without its values", () => {
    run(["add", "school"]);
    const add = run(
      ["vault", "add", "school", "mail", "--url", "https://mail.example.com", "--username", "alice@example.com"],
      "hunter2-correct-horse\n",
    );
    expect(add.code).toBe(0);
    expect(add.out).not.toContain("hunter2");
    const list = run(["vault", "list", "school"]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^mail +password +https:\/\/mail\.example\.com$/m);
    expect(list.out).toContain("turno-browser vault submit school auto|confirm");
    expect(list.out).not.toContain("hunter2");
  });

  it("runs the doctor without starting Chrome", () => {
    run(["add", "school"]);
    const r = run(["doctor", "--no-launch", "--json"]);
    expect([0, 1]).toContain(r.code);
    const report = JSON.parse(r.out) as { ok: boolean; checks: { area: string }[] };
    expect(report.checks.some((c) => c.area === "identity school")).toBe(true);
  });

  it("says do needs turno for now, and still prints its help", () => {
    run(["add", "school"]);
    const r = run(["do", "school", "open", "https://example.com"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^turno-browser: turno-browser do needs turno for now: run `turno browser do <id> <action>`/);
    expect(r.err).toMatch(/A standalone mode is coming\.$/m);
    const short = run(["school", "snapshot"]);
    expect(short.code).toBe(1);
    expect(short.err).toMatch(/needs turno for now/);
    const help = run(["do", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("turno-browser do <id> <action>");
    expect(help.out).toContain("needs turno for now");
    expect(help.out).not.toContain("--profile");
  });

  it("reports usage errors with exit 2, as text or JSON", () => {
    expect(run(["add"])).toMatchObject({
      code: 2,
      err: "turno-browser: add needs an identity id (for example: turno-browser add school)\n",
    });
    const json = run(["show", "nobody", "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.err).error).toMatchObject({ code: "usage", exitCode: 2 });
    expect(run(["nope"]).code).toBe(2);
    expect(run(["--color", "pink", "list"]).code).toBe(2);
    expect(existsSync(join(sb.home, ".config", "turno"))).toBe(false);
  });
});
