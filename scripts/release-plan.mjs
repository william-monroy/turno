#!/usr/bin/env node
// Pack every public package whose version is not on npm yet, for the publish job of
// release.yml. Writes the tarballs, a CycloneDX SBOM per package and plan.json to <out>.
//   node scripts/release-plan.mjs <out>
// plan.json: [{ "name", "version", "tag", "tarball" }]. The dist-tag is "latest", or the
// prerelease id ("next" for 1.2.0-next.0) so a prerelease never becomes the default install.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
for (const dir of readdirSync(join(root, "packages"))) {
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
