import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { paths, writePrivateFile } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { fetchLatest, isSemver, updateChecksOff } from "../../core/update.js";
import { compareVersions, detectInstall, packageInfo, upgradeCommand } from "../../core/version.js";
import { DRY_RUN, JSON_FLAG, bool, parseFlags, printJson, str } from "../args.js";
import { type Command, type Io, fail } from "../io.js";
import { findOnPath, launcherPath } from "../launch.js";
import { turnoCommand, isGenerated, writeHelperLaunchers, writeLauncher } from "../launchers.js";

const USAGE = `Usage:
  turno upgrade [--channel latest|next] [--to <version>] [--dry-run]
                                     install the newest release with the tool that installed turno
  turno upgrade --check [--json]   only ask the registry what the newest release is
  turno upgrade --finish           after an upgrade: rewrite launchers, check config, show what changed

turno knows how it was installed (npm, pnpm, yarn, bun, volta, or a git checkout) and runs the
matching command. Once a day interactive commands look for a new release in the background and
mention it once; set update_check = false in config.toml or TURNO_NO_UPDATE_CHECK=1 to stop that.`;

function versionFile(env: NodeJS.ProcessEnv): string {
  return join(paths(env).state, "version");
}

/** The turno version that last finished an upgrade (or first ran setup). */
export function recordedVersion(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(versionFile(env), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function recordVersion(env: NodeJS.ProcessEnv): void {
  writePrivateFile(versionFile(env), `${packageInfo().version}\n`, env);
}

/** CHANGELOG sections newer than `from`, up to the running version. */
export function changesSince(from: string | undefined, changelog: string, to = packageInfo().version): string {
  const out: string[] = [];
  let keep = false;
  for (const line of changelog.split("\n")) {
    const m = /^## \[?v?(\d+\.\d+\.\d+[^\]\s]*)/.exec(line);
    if (m) keep = compareVersions(m[1]!, to) <= 0 && (!from || compareVersions(m[1]!, from) > 0);
    if (keep) out.push(line);
  }
  return out.join("\n").trim();
}

/** Steps after the files changed: idempotent, safe to run any time. */
export async function finishUpgrade(io: Io): Promise<number> {
  const env = io.env;
  const before = recordedVersion(env);
  const now = packageInfo().version;
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.out(`config: ${(err as Error).message} (turno config edit)`);
  }
  // Launchers bake the path of the running turno, which changes with some package managers.
  let rewritten = 0;
  for (const name of config ? listProfiles(config, env) : []) {
    const file = launcherPath(name, env);
    if (file && isGenerated(file)) {
      writeLauncher(name, env);
      rewritten++;
    }
  }
  const bin = paths(env).bin;
  if (["turno-auto", "turno-open"].some((f) => existsSync(join(bin, f)) && isGenerated(join(bin, f)))) {
    rewritten += writeHelperLaunchers(env, turnoCommand()).length;
  }
  if (rewritten) io.out(`launchers: ${rewritten} rewritten for turno ${now}`);
  // Configs synced before per-profile gateway tokens (ADR 0023) send the master token, which
  // mcpd refuses for MCP sessions: say so here instead of leaving it to the first failed call.
  const tokens = (await import("../../mcpd/health.js")).tokenSyncCheck(env);
  if (tokens) io.out(`${tokens.text}; run: turno mcp sync`);
  await refreshDaemonService(io);
  recordVersion(env);
  if (before && before !== now) {
    io.out(`turno ${before} -> ${now}`);
    const log = join(packageInfo().root, "CHANGELOG.md");
    if (existsSync(log)) {
      const changes = changesSince(before, readFileSync(log, "utf8"));
      if (changes) io.out(`\n${changes}`);
    }
  } else io.out(`turno ${now} is set up`);
  return 0;
}

/**
 * The mcpd service runs the turno that installed it, and the old code keeps running until a
 * restart: rewrite the service file for this version and restart it, when one is installed.
 */
async function refreshDaemonService(io: Io): Promise<void> {
  const { installedBackend } = await import("../../mcpd/service.js");
  const backend = await installedBackend(io.env);
  if (!backend) return;
  io.out(`mcpd: rewriting the ${backend.noun} for turno ${packageInfo().version} and restarting it; open sessions reconnect on their next call`);
  const { installDaemonService } = await import("./mcpd.js");
  const code = await installDaemonService(io, { command: "upgrade --finish" });
  if (code) io.err("turno: mcpd was not restarted; run turno mcp daemon start");
}

export const command: Command = {
  summary: "update turno to the newest release (or check for one)",
  usage: USAGE,
  flags: ["--check", "--channel", "--to", "--dry-run", "--json", "--finish"],
  async run(args, io) {
    const p = parseFlags(args, { check: { type: "boolean" }, finish: { type: "boolean" }, channel: { type: "string" }, to: { type: "string" }, ...DRY_RUN, ...JSON_FLAG }, 0);
    if (bool(p, "finish")) return finishUpgrade(io);
    const to = str(p, "to");
    if (to !== undefined && !isSemver(to)) fail(`--to needs a version like 1.2.3 (got "${to}")`);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(str(p, "channel") ?? "latest")) fail("--channel needs a dist-tag such as latest or next");
    const pkg = packageInfo();
    const install = detectInstall();
    const channel = str(p, "channel") ?? "latest";
    const off = updateChecksOff(io.env);
    const fromRegistry = install.method !== "source" && install.method !== "unknown";

    if (bool(p, "check")) {
      if (pkg.private || !fromRegistry) {
        const why = pkg.private ? "this copy is not published to a registry" : `installed from ${install.method}`;
        if (bool(p, "json")) printJson(io.out, { current: pkg.version, latest: null, method: install.method, note: why });
        else io.out(`turno ${pkg.version} (${why}; turno upgrade pulls the source)`);
        return 0;
      }
      const s = await fetchLatest(io.env, channel);
      const newer = s.latest && compareVersions(s.latest, pkg.version) > 0;
      if (bool(p, "json")) printJson(io.out, { current: pkg.version, latest: s.latest ?? null, channel, method: install.method, updateAvailable: Boolean(newer), error: s.error ?? null });
      else if (s.error) io.out(`could not reach the registry: ${s.error}`);
      else io.out(newer ? `turno ${s.latest} is available (you have ${pkg.version}): turno upgrade` : `turno ${pkg.version} is the newest on ${channel}`);
      return s.error ? 1 : 0;
    }

    if (fromRegistry && off === "this copy is not published to a registry") fail("this copy is not published to a registry");
    let spec = str(p, "to") ?? channel;
    if (fromRegistry && !str(p, "to")) {
      const s = await fetchLatest(io.env, channel);
      if (s.error) fail(`could not reach the registry: ${s.error}`);
      if (s.latest && compareVersions(s.latest, pkg.version) <= 0) {
        io.out(`turno ${pkg.version} is already the newest on ${channel}`);
        return 0;
      }
      spec = s.latest ?? channel;
    }
    // Whatever reaches the package manager is a plain version or a dist-tag, never a URL or range.
    if (!isSemver(spec) && !/^[a-z][a-z0-9-]{0,63}$/.test(spec)) fail(`refusing to install "${spec}": not a version`);
    const steps = upgradeCommand(install, pkg.name, spec);
    if (!steps) return fail(`cannot tell how turno was installed (${install.root}); reinstall it with your package manager`);
    for (const step of steps) {
      io.out(`$ ${step.join(" ")}`);
      if (bool(p, "dry-run")) continue;
      const r = spawnSync(step[0]!, step.slice(1), { stdio: "inherit", env: io.env });
      if (r.status !== 0) {
        io.err(`turno: ${step[0]} failed (exit ${r.status ?? r.signal}); nothing else was changed`);
        return 1;
      }
    }
    if (bool(p, "dry-run")) return 0;
    // The new files are in place: let the new version finish its own upgrade.
    const self = install.method === "source" ? process.argv[1] : findOnPath("turno", io.env);
    if (!self) {
      io.out("upgraded; run `turno upgrade --finish` to rewrite the launchers");
      return 0;
    }
    const r = spawnSync(install.method === "source" ? process.execPath : self, install.method === "source" ? [self, "upgrade", "--finish"] : ["upgrade", "--finish"], { stdio: "inherit", env: io.env });
    return r.status ?? 1;
  },
};
