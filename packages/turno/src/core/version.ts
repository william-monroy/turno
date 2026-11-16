import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
  /** A private package is not on a registry: no update checks, upgrade from source. */
  private: boolean;
  /** Folder of the package (where package.json is). */
  root: string;
}

let cached: PackageInfo | undefined;

/** turno's own package.json (dist/core and src/core both sit two levels below it). */
export function packageInfo(): PackageInfo {
  if (cached) return cached;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; private?: boolean };
  cached = { name: pkg.name, version: pkg.version, private: Boolean(pkg.private), root: root.replace(/\/$/, "") };
  return cached;
}

export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "volta" | "brew" | "source" | "unknown";

export interface Install {
  method: InstallMethod;
  /** Real path of the running package. */
  root: string;
  /** For a source checkout: the repository root. */
  repo?: string;
}

/** How the running turno was installed, from where its files are. */
export function detectInstall(root = packageInfo().root): Install {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* keep it */
  }
  const parts = real.split(sep);
  // Homebrew keeps the npm package under Cellar/<formula>/<version>/libexec: brew owns it.
  if (parts.includes("Cellar") && parts.includes("node_modules")) return { method: "brew", root: real };
  if (parts.includes("node_modules")) {
    const method: InstallMethod = real.includes(`${sep}.volta${sep}`)
      ? "volta"
      : real.includes(`${sep}.bun${sep}`)
        ? "bun"
        : real.includes(`${sep}pnpm${sep}`) || real.includes(`${sep}.pnpm${sep}`)
          ? "pnpm"
          : real.includes(`${sep}yarn${sep}`) || real.includes(`${sep}.yarn${sep}`)
            ? "yarn"
            : "npm";
    return { method, root: real };
  }
  for (let dir = real; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")) && existsSync(join(dir, "pnpm-workspace.yaml"))) return { method: "source", root: real, repo: dir };
  }
  return { method: "unknown", root: real };
}

/** The shell command that moves an install to `spec` (a version or a dist-tag). */
export function upgradeCommand(install: Install, name: string, spec: string): string[][] | undefined {
  const target = `${name}@${spec}`;
  switch (install.method) {
    case "npm":
      return [["npm", "install", "--global", target]];
    case "pnpm":
      return [["pnpm", "add", "--global", target]];
    case "yarn":
      return [["yarn", "global", "add", target]];
    case "bun":
      return [["bun", "add", "--global", target]];
    case "volta":
      return [["volta", "install", target]];
    case "brew":
      // The formula follows the newest release; brew cannot install an arbitrary version.
      return [["brew", "update"], ["brew", "upgrade", "turno"]];
    case "source":
      return [
        ["git", "-C", install.repo!, "pull", "--ff-only"],
        ["pnpm", "-C", install.repo!, "install", "--frozen-lockfile"],
        ["pnpm", "-C", install.repo!, "build"],
      ];
    default:
      return undefined;
  }
}

/** -1, 0 or 1. Plain semver: a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p) ? Number(p) : undefined;
    const qn = /^\d+$/.test(q) ? Number(q) : undefined;
    if (pn !== undefined && qn !== undefined && pn !== qn) return pn < qn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
