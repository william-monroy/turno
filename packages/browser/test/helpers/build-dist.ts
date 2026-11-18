/**
 * Vitest global setup: compiles dist/ once, before any test file runs. The suites that start the
 * built `turno-browser-mcp` (mcp-smoke, browser-tools, chrome-lifecycle, upstream-contract) used to
 * run tsc in their own beforeAll. Files run in parallel, and tsc rewrites every output file, so
 * one file's build could truncate dist/bin/mcp.js while another file was starting it: the server
 * then exited with 1 or closed the connection at random.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const pkg = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync(join(pkg, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
}
