#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { type BuiltArgv, buildArgv } from "../argv.js";
import { mcpEntryPath } from "../patchright.js";

/**
 * turno-browser-mcp [--identity <id>] [playwright-mcp flags]
 *
 * Runs the Patchright build of the Playwright MCP program in this process with stealth
 * defaults (ADR 0005). Speaks MCP over stdio unless `--port` is given.
 */

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
