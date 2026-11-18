import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callArguments, contentText } from "../src/cli/commands/mcp-call.js";
import { main } from "../src/cli/main.js";
import { type RunningDaemon, startDaemon } from "../src/mcpd/daemon.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

let sb: Sandbox;
let daemons: RunningDaemon[] = [];
let savedCwd: string;

beforeEach(() => {
  sb = sandbox();
  daemons = [];
  savedCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(savedCwd);
  for (const d of daemons) await d.stop().catch(() => {});
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

const fx = (extra = "") => `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\n${extra}`;

async function daemon(manifest = fx(), config = ""): Promise<RunningDaemon> {
  sb.write(".config/turno/config.toml", config);
  sb.write(".config/turno/mcp.toml", manifest);
  const d = await startDaemon({ env: sb.env, port: 0 });
  daemons.push(d);
  return d;
}

describe("callArguments", () => {
  it("merges --args with key=value strings and key:=json values", () => {
    expect(callArguments('{"a": 1, "b": "x"}', ["b=y", "n:=5", "list:=[1,2]", "flag:=true", "eq=a=b"])).toEqual({ a: 1, b: "y", n: 5, list: [1, 2], flag: true, eq: "a=b" });
    expect(callArguments(undefined, [])).toEqual({});
  });

  it("refuses arguments it cannot read, as usage errors", () => {
    expect(() => callArguments("[1]", [])).toThrow(/JSON object/);
    expect(() => callArguments("{", [])).toThrow(/not JSON/);
    expect(() => callArguments(undefined, ["novalue"])).toThrow(/key=value/);
    expect(() => callArguments(undefined, ["n:=nope"])).toThrow(/needs JSON/);
  });
});

describe("contentText", () => {
  it("prints text as it is and other content as one bracketed line", () => {
    expect(contentText({ type: "text", text: "hi" })).toBe("hi");
    expect(contentText({ type: "image", mimeType: "image/png", data: "AAAA" })).toBe("[image image/png, 3 bytes]");
    expect(contentText({ type: "resource", resource: { uri: "file:///a", mimeType: "text/plain" } })).toBe("[resource file:///a, text/plain]");
    expect(contentText({ type: "resource_link", uri: "file:///b", name: "b" })).toBe("[link file:///b (b)]");
  });
});

describe("turno mcp call", () => {
  it("calls a tool through mcpd and prints its text", async () => {
    await daemon();
    const r = await run(["mcp", "call", "fx", "echo", "--arg", "text=hello there"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("hello there");
  });

  it("prints the result with schemaVersion under --json, and the profile it called as", async () => {
    await daemon();
    const r = await run(["mcp", "call", "fx", "echo", "--args", '{"text": "j"}', "--profile", "work", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ schemaVersion: 1, server: "fx", tool: "echo", profile: "work", isError: false, content: [{ type: "text", text: "j" }], tools: null });
    expect(typeof out.ms).toBe("number");
  });

  it("lists the tools without a tool name", async () => {
    await daemon();
    const r = await run(["mcp", "call", "fx"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^echo\s+Echo text$/m);
    const j = JSON.parse((await run(["mcp", "call", "fx", "--json=tools"])).out);
    expect(j.tools.map((t: { name: string }) => t.name)).toContain("whoami");
  });

  it("applies the profile's tool filter like an agent session", async () => {
    await daemon(fx('tools = { deny = ["echo"] }\n'));
    const r = await run(["mcp", "call", "fx", "echo", "--arg", "text=x"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/fx\/echo: .*echo/);
  });

  it("uses this folder, so a [[projects]] server set hides the server here", async () => {
    const dir = join(sb.home, "code", "other");
    mkdirSync(dir, { recursive: true });
    await daemon(fx(), `[[projects]]\npath = ${JSON.stringify(dir)}\nmcp = ["nothing"]\n`);
    process.chdir(dir);
    const r = await run(["mcp", "call", "fx", "echo", "--arg", "text=x"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not in the MCP set/);
  });

  it("exits 1 when the tool fails", async () => {
    await daemon();
    const r = await run(["mcp", "call", "fx", "no_such_tool"]);
    expect(r.code).toBe(1);
  });

  it("exits 5 when mcpd is not running, with a JSON error under --json", async () => {
    sb.write(".config/turno/mcp.toml", fx());
    const r = await run(["mcp", "call", "fx", "echo"]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/mcpd is not running/);
    const j = await run(["mcp", "call", "fx", "echo", "--json"]);
    expect(j.code).toBe(5);
    expect(JSON.parse(j.err).error.code).toBe("gateway_down");
  });

  it("refuses unknown servers, direct remotes and servers the profile does not get", async () => {
    sb.write(
      ".config/turno/mcp.toml",
      `${fx('profiles = ["work"]\n')}\n[server.web]\nurl = "https://example.com/mcp"\n`,
    );
    expect((await run(["mcp", "call", "nope", "x"])).code).toBe(2);
    const direct = await run(["mcp", "call", "web", "x"]);
    expect(direct.code).toBe(1);
    expect(direct.err).toMatch(/reach directly/);
    const other = await run(["mcp", "call", "fx", "echo", "--profile", "home"]);
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/not served to profile home/);
  });

  it("answers --json=fields without mcpd", async () => {
    const r = await run(["mcp", "call", "--json=fields"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/structuredContent/);
  });
});
