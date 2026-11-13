#!/usr/bin/env node
// Check what each package would publish, before any release: the files a user needs are in
// the tarball, nothing that should stay home is, and no file carries a local path.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const MAX_BYTES = 20 * 1024 * 1024;
const FORBIDDEN = [/^test\//, /^src\//, /\.map$/, /(^|\/)\.env/, /\.tgz$/, /(^|\/)\.DS_Store$/, /(^|\/)node_modules\//, /\.tmp$/];
const home = homedir();
let failed = 0;
const fail = (pkg, msg) => {
  failed++;
  console.error(`FAIL ${pkg}: ${msg}`);
};

for (const dir of readdirSync(join(root, "packages"))) {
  const cwd = join(root, "packages", dir);
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const out = execFileSync("pnpm", ["pack", "--dry-run", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const report = JSON.parse(out.slice(out.indexOf("{")));
  const files = report.files.map((f) => f.path);
  const has = new Set(files);
  const need = [
    ...Object.values(typeof pkg.bin === "string" ? { x: pkg.bin } : (pkg.bin ?? {})),
    pkg.main,
    pkg.types,
    ...Object.values(pkg.exports?.["."] ?? {}),
  ]
    .filter((f) => typeof f === "string")
    .map((f) => f.replace(/^\.\//, ""));
  for (const f of need) if (!has.has(f)) fail(pkg.name, `${f} is referenced by package.json but not packed (did the build run?)`);
  for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) fail(pkg.name, `${f} should not be published`);
  let bytes = 0;
  for (const f of files) {
    // pnpm adds the workspace LICENSE to packages that have none of their own.
    const buf = readFileSync(existsSync(join(cwd, f)) ? join(cwd, f) : join(root, f));
    bytes += buf.length;
    if (!buf.includes(0) && buf.toString("utf8").includes(home)) fail(pkg.name, `${f} contains a local home path`);
    if (!pkg.private && !buf.includes(0) && buf.toString("utf8").includes("github.com/OWNER/")) fail(pkg.name, `${f} still links to the OWNER placeholder repository`);
  }
  for (const bin of Object.values(typeof pkg.bin === "string" ? { x: pkg.bin } : (pkg.bin ?? {}))) {
    if (has.has(bin) && !readFileSync(join(cwd, bin), "utf8").startsWith("#!/usr/bin/env node")) fail(pkg.name, `${bin} has no node shebang`);
  }
  if (bytes > MAX_BYTES) fail(pkg.name, `${(bytes / 1e6).toFixed(1)} MB unpacked is over the ${MAX_BYTES / 1e6} MB limit`);
  if (!pkg.license) fail(pkg.name, "no license field");
  console.log(`${failed ? "    " : "ok  "}${pkg.name}@${pkg.version}: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB${pkg.private ? " (private: not publishable yet)" : ""}`);
}
process.exit(failed ? 1 : 0);
