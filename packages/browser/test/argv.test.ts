import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArgv, extractIdentity } from "../src/argv.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const fakeTemp = () => "/tmp/turno-browser-test";

describe("buildArgv", () => {
  it("adds the chrome channel and a temporary profile without an identity", () => {
    const b = buildArgv([], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual(["--browser", "chrome", "--user-data-dir", "/tmp/turno-browser-test/profile"]);
    expect(b.tempDir).toBe("/tmp/turno-browser-test");
    expect(b.identity).toBeUndefined();
  });

  it("uses the identity dir under the data dir", () => {
    const b = buildArgv(["--identity", "school"], { env: sb.env, makeTempDir: fakeTemp });
    const dir = join(sb.home, ".local", "share", "turno", "browser", "identities", "school");
    expect(b.args).toEqual(["--browser", "chrome", "--user-data-dir", dir]);
    expect(b.identity).toBe("school");
    expect(b.tempDir).toBeUndefined();
  });

  it("honors XDG_DATA_HOME and the --identity=<id> form", () => {
    const env = { ...sb.env, XDG_DATA_HOME: join(sb.home, "xdg") };
    const b = buildArgv(["--identity=bank"], { env });
    expect(b.userDataDir).toBe(join(sb.home, "xdg", "turno", "browser", "identities", "bank"));
  });

  it("never adds headless, viewport or init-script flags", () => {
    const b = buildArgv(["--identity", "work"], { env: sb.env });
    expect(b.args.join(" ")).not.toMatch(/--headless|--viewport-size|--init-script|--isolated/);
  });

  it("keeps user flags and lets them win over defaults", () => {
    const b = buildArgv(["--browser", "msedge", "--user-data-dir", "/x/profile", "--headless"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual(["--browser", "msedge", "--user-data-dir", "/x/profile", "--headless"]);
    expect(b.tempDir).toBeUndefined();
  });

  it("accepts the --flag=value form as an override", () => {
    const b = buildArgv(["--browser=chrome-beta"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args.filter((a) => a.startsWith("--browser"))).toEqual(["--browser=chrome-beta"]);
  });

  it("adds nothing browser-related when attaching to an external browser", () => {
    const b = buildArgv(["--cdp-endpoint", "http://127.0.0.1:9222"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual(["--cdp-endpoint", "http://127.0.0.1:9222"]);
  });

  it("keeps --isolated in memory without a profile dir", () => {
    const b = buildArgv(["--isolated"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual(["--isolated", "--browser", "chrome"]);
  });

  it("rejects an identity combined with another profile source", () => {
    expect(() => buildArgv(["--identity", "school", "--user-data-dir", "/x"], { env: sb.env })).toThrow(/cannot be combined/);
    expect(() => buildArgv(["--identity", "school", "--isolated"], { env: sb.env })).toThrow(/cannot be combined/);
  });

  it("rejects invalid or missing identity values", () => {
    expect(() => extractIdentity(["--identity"])).toThrow(/needs a value/);
    expect(() => extractIdentity(["--identity", "../etc"])).toThrow(/invalid identity/);
    expect(() => extractIdentity(["--identity", "School"])).toThrow(/invalid identity/);
  });
});
