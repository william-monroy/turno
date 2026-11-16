#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { type BuiltArgv, buildArgv } from "../argv.js";
import { mcpEntryPath } from "../patchright.js";

/**
 * turno-browser-mcp [--identity <id>] [playwright-mcp flags]
 *
 * Runs the Patchright build of the Playwright MCP program in this process with the defaults of
 * ADR 0005. Speaks MCP over stdio; `--port` with `--identity` needs `--allow-http-identity`.
 */

const HELP = `turno-browser-mcp: a browser MCP server that drives your installed Chrome, with one
persistent profile per identity (turno identity add browser:<id>).

  --identity <id>          use the identity's saved profile (served one session at a time by mcpd)
  --allow-http-identity    allow --port or --host together with --identity; the server then
                           binds to 127.0.0.1 only. Any local process can use that browser.

Every other flag goes to the Playwright MCP program:
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) process.stdout.write(`${HELP}\n`);

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

const entry = mcpEntryPath();
// The program parses process.argv with commander ("node <script> ...flags").
process.argv = [process.argv[0]!, entry, ...built.args];
createRequire(import.meta.url)(entry);
