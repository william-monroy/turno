#!/usr/bin/env node
// Pack every public package whose version is not on npm yet, for the publish job of
// release.yml. Writes the tarballs, a CycloneDX SBOM per package and plan.json to <out>.
// Packing runs each package's prepack, which writes its npm-shrinkwrap.json.
//   node scripts/release-plan.mjs <out>
// plan.json: [{ "name", "version", "tag", "tarball" }]. The dist-tag is "latest", or the
// prerelease id ("next" for 1.2.0-next.0) so a prerelease never becomes the default install.
// The plan lists a package after the workspace packages it depends on (turno-core before
// turno-cli and turno-browser, ADR 0053), and the publish job publishes in that order.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package folders in publish order: each after the workspace packages it depends on
 * (dependencies, optional and peer dependencies; dev dependencies never ship). Ties keep the
 * folder order. Throws on a cycle.
 */
export function publishOrder(manifests) {
  const byName = new Map(manifests.map((m) => [m.manifest.name, m]));
  const out = [];
  const state = new Map();
  const visit = (entry, path) => {
    const name = entry.manifest.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`workspace dependency cycle: ${[...path, name].join(" -> ")}`);
    state.set(name, "visiting");
    for (const f of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(entry.manifest[f] ?? {}).sort()) {
        const sibling = byName.get(dep);
        if (sibling) visit(sibling, [...path, name]);
      }
    }
    state.set(name, "done");
    out.push(entry.dir);
  };
  for (const entry of manifests) visit(entry, []);
  return out;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
  const root = new URL("..", import.meta.url).pathname;
  const out = resolve(process.argv[2] ?? "release");
  mkdirSync(out, { recursive: true });

  function onNpm(name, version) {
    try {
      execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: ["ignore", "pipe", "ignore"] });
      return true;
    } catch {
      return false; // E404: not published yet
    }
  }

  const plan = [];
  const folders = readdirSync(join(root, "packages")).map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) }));
  for (const dir of publishOrder(folders)) {
    const cwd = join(root, "packages", dir);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (pkg.private) {
      console.log(`skip ${pkg.name}: private`);
      continue;
    }
    if (onNpm(pkg.name, pkg.version)) {
      console.log(`skip ${pkg.name}@${pkg.version}: already on npm`);
      continue;
    }
    const report = execFileSync("pnpm", ["pack", "--pack-destination", out, "--json"], { cwd, encoding: "utf8" });
    const { filename } = JSON.parse(report.slice(report.indexOf("{")));
    const tarball = filename.split("/").pop();
    // prepack wrote npm-shrinkwrap.json (ADR 0019); a tarball with dependencies must carry it.
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length > 0;
    const listing = execFileSync("tar", ["-tzf", join(out, tarball)], { encoding: "utf8" }).split("\n");
    if (hasDeps && !listing.includes("package/npm-shrinkwrap.json")) {
      throw new Error(`${tarball} has dependencies but no npm-shrinkwrap.json`);
    }
    const sbom = execFileSync("pnpm", ["sbom", "--sbom-format", "cyclonedx", "--sbom-type", "application", "--prod"], {
      cwd,
      encoding: "utf8",
    });
    writeFileSync(join(out, tarball.replace(/\.tgz$/, ".cdx.json")), sbom);
    const pre = /-([a-z]+)/.exec(pkg.version);
    plan.push({ name: pkg.name, version: pkg.version, tag: pre ? pre[1] : "latest", tarball });
    console.log(`pack ${pkg.name}@${pkg.version} -> ${tarball}`);
  }
  writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`${plan.length} package(s) to publish`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `count=${plan.length}\n`, { flag: "a" });
  }
}
