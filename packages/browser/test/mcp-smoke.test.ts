import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Starts the built `turno-browser-mcp` over stdio and lists its tools. Listing tools does
 * not launch Chrome, so this stays offline and headless-safe. It guards the internal
 * patchright-core entry path (ADR 0003) against upgrades.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  mkdirSync(join(sb.home, "tmp"));
  sb.env.TMPDIR = join(sb.home, "tmp");
});
afterEach(() => sb.cleanup());

async function listTools(args: string[]): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("turno-browser-mcp", () => {
  it("serves the Playwright MCP tools for an identity without launching Chrome", async () => {
    const names = await listTools(["--identity", "school"]);
    expect(names).toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_click", "browser_console_messages"]),
    );
    const dir = join(sb.home, ".local", "share", "turno", "browser", "identities", "school");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes its temporary profile on exit when no identity is given", async () => {
    const names = await listTools([]);
    expect(names.length).toBeGreaterThan(10);
    for (let i = 0; i < 50 && readdirSync(join(sb.home, "tmp")).some((n) => n.startsWith("turno-browser-")); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readdirSync(join(sb.home, "tmp")).filter((n) => n.startsWith("turno-browser-"))).toEqual([]);
  });

  it("exits with an error for an invalid identity", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [bin, "--identity", "Bad Id"], { env: sb.env, stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(2);
  });

  it("refuses to serve an identity over HTTP without --allow-http-identity", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [bin, "--identity", "school", "--port", "0"], { env: sb.env, stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: Buffer }).stderr);
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/--allow-http-identity/);
    expect(existsSync(join(sb.home, ".local", "share", "turno", "browser", "identities", "school"))).toBe(false);
  });

  it("describes the turno flags in --help", () => {
    const out = execFileSync(process.execPath, [bin, "--help"], { env: sb.env, encoding: "utf8" });
    expect(out).toMatch(/--allow-http-identity/);
    expect(out).toMatch(/--identity <id>/);
  });
});
