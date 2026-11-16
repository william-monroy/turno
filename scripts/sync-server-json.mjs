#!/usr/bin/env node
// Keeps packages/browser/server.json (the MCP Registry entry) on the version of the npm package
// it describes. The registry checks that the package's mcpName matches the server name, so a
// mismatch fails here instead of at publish time. Runs after `changeset version`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Returns a copy of server.json with the npm package's version. */
export function syncServerJson(server, pkg) {
  if (pkg.mcpName !== server.name) {
    throw new Error(`mcpName ${pkg.mcpName} does not match server.json name ${server.name}`);
  }
  return {
    ...server,
    version: pkg.version,
    packages: server.packages.map((p) =>
      p.registryType === "npm" && p.identifier === pkg.name ? { ...p, version: pkg.version } : p,
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../packages/browser");
  const file = join(dir, "server.json");
  const server = JSON.parse(readFileSync(file, "utf8"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(file, `${JSON.stringify(syncServerJson(server, pkg), null, 2)}\n`);
}
