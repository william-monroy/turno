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

  it("refuses to serve a signed-in identity over HTTP without an explicit opt-in", () => {
    expect(() => buildArgv(["--identity", "school", "--port", "8931"], { env: sb.env })).toThrow(/--allow-http-identity/);
    expect(() => buildArgv(["--identity=school", "--port=8931"], { env: sb.env })).toThrow(/--allow-http-identity/);
    expect(() => buildArgv(["--identity", "school", "--host", "127.0.0.1"], { env: sb.env })).toThrow(/--allow-http-identity/);
  });

  it("with --allow-http-identity binds to 127.0.0.1 only and drops the turno flag", () => {
    const b = buildArgv(["--identity", "school", "--port", "8931", "--allow-http-identity"], { env: sb.env });
    expect(b.args).not.toContain("--allow-http-identity");
    expect(b.args.slice(0, 4)).toEqual(["--port", "8931", "--host", "127.0.0.1"]);
    const local = buildArgv(["--identity", "school", "--port", "8931", "--host", "localhost", "--allow-http-identity"], { env: sb.env });
    expect(local.args.filter((a) => a === "--host")).toHaveLength(1);
  });

  it("never serves an identity on a public address or with the host check off", () => {
    const opt = ["--identity", "school", "--port", "8931", "--allow-http-identity"];
    expect(() => buildArgv([...opt, "--host", "0.0.0.0"], { env: sb.env })).toThrow(/loopback/);
    expect(() => buildArgv([...opt, "--host=192.168.1.5"], { env: sb.env })).toThrow(/loopback/);
    expect(() => buildArgv([...opt, "--allowed-hosts", "*"], { env: sb.env })).toThrow(/allowed-hosts/);
  });

  it("keeps --port without an identity (temporary profile, nothing signed in)", () => {
    const b = buildArgv(["--port", "8931"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args.slice(0, 2)).toEqual(["--port", "8931"]);
    expect(() => buildArgv(["--port", "8931", "--allow-http-identity"], { env: sb.env, makeTempDir: fakeTemp })).toThrow(/only with --identity/);
  });
});
