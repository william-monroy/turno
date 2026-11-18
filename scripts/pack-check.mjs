#!/usr/bin/env node
// Check what each package would publish, before any release: the files a user needs are in
// the tarball, nothing that should stay home is, and no file carries a local path. Published
// dependencies are exact versions, a package with dependencies ships an npm-shrinkwrap.json
// that matches pnpm-lock.yaml and the installed tree, and nothing in that tree runs an install
// script (ADR 0019).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE,
  collectGraph,
  inexactDependencies,
  installScripts,
  publishedManifest,
  shrinkwrapProblems,
  shrinkwrapText,
  workspaceVersions,
} from "./shrinkwrap.mjs";

const root = new URL("..", import.meta.url).pathname;
const MAX_BYTES = 20 * 1024 * 1024;
const FORBIDDEN = [
  /^test\//,
  /^src\//,
  /\.map$/,
  /(^|\/)\.env/,
  /\.tgz$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)node_modules\//,
  /\.tmp$/,
];
const home = homedir();
let failed = 0;
const fail = (pkg, msg) => {
  failed++;
  console.error(`FAIL ${pkg}: ${msg}`);
};

for (const dir of readdirSync(join(root, "packages"))) {
  const cwd = join(root, "packages", dir);
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const out = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
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
  for (const f of need)
    if (!has.has(f)) fail(pkg.name, `${f} is referenced by package.json but not packed (did the build run?)`);
  for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) fail(pkg.name, `${f} should not be published`);
  let bytes = 0;
  for (const f of files) {
    // pnpm adds the workspace LICENSE to packages that have none of their own.
    const buf = readFileSync(existsSync(join(cwd, f)) ? join(cwd, f) : join(root, f));
    bytes += buf.length;
    if (!buf.includes(0) && buf.toString("utf8").includes(home)) fail(pkg.name, `${f} contains a local home path`);
    if (!pkg.private && !buf.includes(0) && buf.toString("utf8").includes("github.com/OWNER/"))
      fail(pkg.name, `${f} still links to the OWNER placeholder repository`);
  }
  for (const bin of Object.values(typeof pkg.bin === "string" ? { x: pkg.bin } : (pkg.bin ?? {}))) {
    if (has.has(bin) && !readFileSync(join(cwd, bin), "utf8").startsWith("#!/usr/bin/env node"))
      fail(pkg.name, `${bin} has no node shebang`);
  }
  if (bytes > MAX_BYTES)
    fail(pkg.name, `${(bytes / 1e6).toFixed(1)} MB unpacked is over the ${MAX_BYTES / 1e6} MB limit`);
  if (!pkg.license) fail(pkg.name, "no license field");
  if (!pkg.private) checkTree(cwd, pkg, has);
  console.log(
    `${failed ? "    " : "ok  "}${pkg.name}@${pkg.version}: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB${pkg.private ? " (private: not publishable yet)" : ""}`,
  );
}
process.exit(failed ? 1 : 0);

/** Exact versions, zero install scripts, and a shrinkwrap that npm itself accepts. */
function checkTree(cwd, source, packed) {
  // What pnpm publishes: workspace:* dependencies (turno-core, ADR 0053) become exact versions.
  const pkg = publishedManifest(source, workspaceVersions(cwd));
  for (const d of inexactDependencies(pkg)) fail(pkg.name, `${d} is not an exact version`);
  for (const s of installScripts(pkg, cwd)) fail(pkg.name, `runs an install script (${s})`);
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length > 0;
  if (!hasDeps) return;
  if (!packed.has(FILE)) return fail(pkg.name, `${FILE} is not in the tarball (add it to "files")`);
  const file = join(cwd, FILE);
  if (!existsSync(file)) return fail(pkg.name, `${FILE} is missing (node scripts/shrinkwrap.mjs packages/<dir>)`);
  const text = readFileSync(file, "utf8");
  let graph;
  try {
    graph = collectGraph(cwd);
    if (text !== shrinkwrapText(cwd, readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))) {
      fail(pkg.name, `${FILE} does not match pnpm-lock.yaml and the installed tree; regenerate it`);
    }
  } catch (err) {
    return fail(pkg.name, `${FILE}: ${err.message}`);
  }
  for (const p of shrinkwrapProblems(pkg, JSON.parse(text), graph)) fail(pkg.name, `${FILE}: ${p}`);
  // npm's own view: every edge of the locked tree resolves to a version in range (offline).
  const tmp = mkdtempSync(join(tmpdir(), "turno-pack-check-"));
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {} }),
    );
    writeFileSync(join(tmp, FILE), text);
    execFileSync("npm", ["ls", "--package-lock-only", "--all", "--offline", "--json"], {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
    });
  } catch (err) {
    const problems = (() => {
      try {
        return JSON.parse(String(err.stdout)).problems ?? [];
      } catch {
        return [String(err.stderr || err.message).split("\n")[0]];
      }
    })();
    for (const p of problems) fail(pkg.name, `npm ls on ${FILE}: ${p}`);
    if (!problems.length) fail(pkg.name, `npm ls on ${FILE} failed`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
