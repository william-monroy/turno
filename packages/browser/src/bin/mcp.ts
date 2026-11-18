#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { type BuiltArgv, buildArgv } from "../argv.js";
import { installShutdownGuard, sweepOrphan } from "../lifecycle.js";
import { mcpEntryPath } from "../patchright.js";

/**
 * turno-browser-mcp [--identity <id>] [playwright-mcp flags]
 *
 * Runs the Patchright build of the Playwright MCP program in this process with the defaults of
 * ADR 0005 and the lifecycle of ADR 0042: a generated config that closes an idle Chrome, a sweep
 * of a Chrome an earlier run left behind on the same profile, and a deadline on shutdown.
 * Speaks MCP over stdio; `--port` with `--identity` needs `--allow-http-identity`.
 */

const HELP = `turno-browser-mcp: a browser MCP server that drives your installed Chrome, with one
persistent profile per identity (turno identity add browser:<id>).

  --identity <id>          use the identity's saved profile (served one session at a time by mcpd)
  --allow-http-identity    allow --port or --host together with --identity; the server then
                           binds to 127.0.0.1 only. Any local process can use that browser.

  TURNO_BROWSER_IDLE=15m   close Chrome after this long without a tool call (headed too); the
                           next call opens it again with the same profile. "0" keeps it open.
                           --idle-timeout <ms> and a --config of your own take precedence.

Every other flag goes to the Playwright MCP program:
`;

const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help) process.stdout.write(`${HELP}\n`);

let built: BuiltArgv;
try {
  built = buildArgv(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`turno-browser-mcp: ${(err as Error).message}\n`);
  process.exit(2);
}

if (built.identity !== undefined && built.userDataDir) mkdirSync(built.userDataDir, { recursive: true, mode: 0o700 });
if (built.tempDir) {
  const dir = built.tempDir;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
if (built.config && !help) {
  mkdirSync(dirname(built.config.path), { recursive: true, mode: 0o700 });
  writeFileSync(built.config.path, `${JSON.stringify(built.config.data, null, 2)}\n`, { mode: 0o600 });
}
if (built.userDataDir && !help) {
  const swept = await sweepOrphan(built.userDataDir);
  if (swept.action === "exited" || swept.action === "killed") {
    process.stderr.write(`turno-browser-mcp: closed a Chrome an earlier run left open on this profile (pid ${swept.pid})\n`);
  } else if (swept.action === "survived") {
    process.stderr.write(`turno-browser-mcp: a Chrome an earlier run left open on this profile (pid ${swept.pid}) did not stop\n`);
  }
  installShutdownGuard(built.userDataDir);
}

const entry = mcpEntryPath();
// The program parses process.argv with commander ("node <script> ...flags").
process.argv = [process.argv[0]!, entry, ...built.args];
createRequire(import.meta.url)(entry);
