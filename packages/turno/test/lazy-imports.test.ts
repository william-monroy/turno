import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import module from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_MAIN = join(PKG, "dist/cli/main.js");
// The load hook needs module.registerHooks (Node 22.15 and later) and a built CLI.
const READY = existsSync(DIST_MAIN) && typeof (module as { registerHooks?: unknown }).registerHooks === "function";

const HOOK = `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({ load(url, context, next) { if (url.startsWith("file:")) appendFileSync(process.env.TRACE_OUT, url + "\\n"); return next(url, context); } });
`;

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** The files the built CLI loads for `args`. */
function loaded(args: string[]): string[] {
  const hook = sb.write("hook.mjs", HOOK);
  const out = join(sb.home, "trace.txt");
  const r = spawnSync(process.execPath, ["--import", hook, DIST_MAIN, ...args], {
    env: { ...sb.env, TRACE_OUT: out, NODE_DISABLE_COMPILE_CACHE: "1" },
    encoding: "utf8",
    input: "",
  });
  expect(r.error).toBeUndefined();
  return existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
}

describe.skipIf(!READY)("commands that only read state load neither mcpd nor the MCP SDK", () => {
  it("doctor --summary, doctor --security, uninstall --help and --dry-run, mcp log", () => {
    sb.write(".config/turno/config.toml", "[profiles.work]\n");
    sb.write(".config/turno/mcp.toml", '[server.gh]\ncommand = "gh-mcp"\n');
    for (const args of [["doctor", "--summary"], ["doctor", "--security", "--summary"], ["uninstall", "--help"], ["uninstall", "--dry-run"], ["mcp", "log", "--tail", "1"]]) {
      const files = loaded(args);
      expect(files.some((f) => f.endsWith("/dist/cli/main.js")), args.join(" ")).toBe(true);
      expect(files.filter((f) => f.endsWith("/mcpd/daemon.js") || f.includes("@modelcontextprotocol")), args.join(" ")).toEqual([]);
    }
  });
});
