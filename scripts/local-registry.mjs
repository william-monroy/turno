#!/usr/bin/env node
// A local npm registry for the install smoke test (scripts/install-smoke.sh). It serves the
// packed workspace packages from a folder of tarballs and forwards every other request to
// registry.npmjs.org, so a package manager can install turno-cli before its workspace
// dependencies (turno-core) are published. Each tarball is its package's only version.
//   node scripts/local-registry.mjs <tarball folder>
// Prints the registry URL (http://127.0.0.1:<port>/) on stdout once it listens, then runs until
// it is killed. npm rewrites the registry.npmjs.org URLs in a shrinkwrap to the configured
// registry (replace-registry-host), so a shrinkwrapped turno-core resolves here too.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UPSTREAM = "https://registry.npmjs.org";
// Old enough for any minimum release age (pnpm 11 waits a day before installing a new version).
const PUBLISHED = "2000-01-01T00:00:00.000Z";

/** The package.json inside a tarball. */
function manifestOf(file) {
  return JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
}

/** name -> { manifest, file, bytes } for every .tgz in the folder. */
export function readTarballs(folder) {
  const out = new Map();
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".tgz")).sort()) {
    const file = join(folder, name);
    out.set(manifestOf(file).name, { manifest: manifestOf(file), file, bytes: readFileSync(file) });
  }
  return out;
}

/** The registry document of a package with one version, whose tarball is served at `base`. */
export function packument({ manifest, bytes }, base) {
  const { name, version } = manifest;
  const tarball = `${base}${name}/-/${name.split("/").pop()}-${version}.tgz`;
  const dist = {
    tarball,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  return {
    name,
    "dist-tags": { latest: version },
    versions: { [version]: { ...manifest, _id: `${name}@${version}`, dist } },
    time: { created: PUBLISHED, modified: PUBLISHED, [version]: PUBLISHED },
  };
}

/** Starts the registry on 127.0.0.1 and resolves with its base URL and the server. */
export function serve(folder, port = 0) {
  const local = readTarballs(folder);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname).slice(1);
    const base = `http://127.0.0.1:${server.address().port}/`;
    const [, name, file] = path.match(/^((?:@[^/]+\/)?[^/]+)(?:\/-\/(.+))?$/) ?? [];
    const pkg = name ? local.get(name) : undefined;
    if (pkg && !file) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(packument(pkg, base)));
    }
    if (pkg && file) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": pkg.bytes.length });
      return res.end(pkg.bytes);
    }
    try {
      const up = await fetch(`${UPSTREAM}${req.url}`, {
        headers: { accept: req.headers.accept ?? "application/json" },
      });
      const body = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}/`, server })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("usage: local-registry.mjs <tarball folder>");
    process.exit(2);
  }
  const { url } = await serve(resolve(folder));
  console.log(url);
}
