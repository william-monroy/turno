import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { paths, writePrivateFile } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { fetchLatest, isSemver, updateChecksOff } from "../../core/update.js";
import {
  type Install,
  ONE_OFF_RUNNERS,
  compareVersions,
  detectInstall,
  isOneOff,
  packageInfo,
  upgradeCommand,
} from "../../core/version.js";
import { DRY_RUN, JSON_FLAG, bool, parseFlags, str } from "../args.js";
import { emit, jsonOutput } from "../output.js";
import { type Command, type Io, confirm, fail } from "../io.js";
import { findOnPath, launcherPath } from "../launch.js";
import { turnoCommand, isGenerated, writeHelperLaunchers, writeLauncher } from "../launchers.js";

/** `turno upgrade --check --json`. */
const CHECK_JSON = jsonOutput(["current", "latest", "channel", "method", "updateAvailable", "error", "note"]);

const USAGE = `Usage:
  turno upgrade [--channel latest|next] [--to <version>] [--dry-run] [--yes]
                                     install the newest release with the tool that installed turno
  turno upgrade --check [--json]   only ask the registry what the newest release is
  turno upgrade --finish [--yes]   after an upgrade: rewrite launchers, check config, show what changed

When agent configs need a new gateway token, --finish offers to run turno mcp sync (in a
terminal it asks; --yes runs it without asking).

turno knows how it was installed (npm, pnpm, yarn, bun, volta, Homebrew, or a git checkout) and
runs the matching command. A copy that npx, pnpm dlx or bunx runs once has nothing to upgrade:
the next run of that runner with @latest gets the newest release. Once a day interactive commands look for a new release in the background and
mention it once; set update_check = false in config.toml or TURNO_NO_UPDATE_CHECK=1 to stop that.

Examples:
  $ turno upgrade --check
  $ turno upgrade
  $ turno upgrade --dry-run --to 1.2.3
  $ turno upgrade --finish`;

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

/**
 * Steps after the files changed: idempotent, safe to run any time. `sync` says what to do when
 * agent configs need `turno mcp sync`: ask (in a terminal; elsewhere only say so), run it, or
 * only say so (doctor, which offers the sync as a fix of its own).
 */
export async function finishUpgrade(io: Io, opts: { sync?: "ask" | "yes" | "no" } = {}): Promise<number> {
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
  // The journal records the ones that change, so `turno undo` can put the old ones back.
  const journal = new Journal(env, "upgrade --finish");
  let rewritten = 0;
  for (const name of config ? listProfiles(config, env) : []) {
    const file = launcherPath(name, env);
    if (file && isGenerated(file)) {
      writeLauncher(name, env, undefined, journal);
      rewritten++;
    }
  }
  const bin = paths(env).bin;
  if (["turno-auto", "turno-open"].some((f) => existsSync(join(bin, f)) && isGenerated(join(bin, f)))) {
    rewritten += writeHelperLaunchers(env, turnoCommand(), journal).length;
  }
  if (rewritten) io.out(`launchers: ${rewritten} rewritten for turno ${now}`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  // Configs synced before per-profile gateway tokens send the master token, which
  // mcpd refuses for MCP sessions: say so here instead of leaving it to the first failed call.
  const tokens = (await import("../../mcpd/health.js")).tokenSyncCheck(env);
  if (tokens) {
    const mode = opts.sync ?? "ask";
    let run = mode === "yes";
    if (mode === "ask" && io.ask) {
      io.out(tokens.text);
      run = await confirm(io, "run turno mcp sync now?");
    }
    if (run) {
      const { command } = await import("./mcp.js");
      if ((await command.run(["sync"], io)) !== 0)
        io.err("turno: turno mcp sync did not finish every profile; run it again once their sessions are closed");
    } else io.out(`${tokens.text}; run: turno mcp sync`);
  }
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
  io.out(
    `mcpd: rewriting the ${backend.noun} for turno ${packageInfo().version} and restarting it; open sessions reconnect on their next call`,
  );
  const { installDaemonService } = await import("./mcpd.js");
  const code = await installDaemonService(io, { command: "upgrade --finish" });
  if (code) io.err("turno: mcpd was not restarted; run turno mcp daemon start");
}

export const command: Command = {
  summary: "update turno to the newest release (or check for one)",
  usage: USAGE,
  flags: ["--check", "--channel", "--to", "--dry-run", "--json", "--finish", "--yes"],
  json: CHECK_JSON,
  run: (args, io) => runUpgrade(args, io),
};

/** `turno upgrade`; `deps.install` stands for how this turno was installed, for tests. */
export async function runUpgrade(args: string[], io: Io, deps: { install?: Install } = {}): Promise<number> {
  const p = parseFlags(
    args,
    {
      check: { type: "boolean" },
      finish: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      channel: { type: "string" },
      to: { type: "string" },
      ...DRY_RUN,
      ...JSON_FLAG,
    },
    0,
  );
  const yes = bool(p, "yes");
  if (bool(p, "finish")) return finishUpgrade(io, { sync: yes ? "yes" : "ask" });
  const to = str(p, "to");
  if (to !== undefined && !isSemver(to)) fail(`--to needs a version like 1.2.3 (got "${to}")`);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(str(p, "channel") ?? "latest"))
    fail("--channel needs a dist-tag such as latest or next");
  const pkg = packageInfo();
  const install = deps.install ?? detectInstall();
  const channel = str(p, "channel") ?? "latest";
  const off = updateChecksOff(io.env);
  const fromRegistry = install.method !== "source" && install.method !== "unknown";

  if (bool(p, "check")) {
    if (pkg.private || !fromRegistry) {
      const why = pkg.private ? "this copy is not published to a registry" : `installed from ${install.method}`;
      if (bool(p, "json"))
        emit(io, p, CHECK_JSON, { current: pkg.version, latest: null, method: install.method, note: why });
      else io.out(`turno ${pkg.version} (${why}; turno upgrade pulls the source)`);
      return 0;
    }
    const s = await fetchLatest(io.env, channel);
    const newer = s.latest && compareVersions(s.latest, pkg.version) > 0;
    if (bool(p, "json"))
      emit(io, p, CHECK_JSON, {
        current: pkg.version,
        latest: s.latest ?? null,
        channel,
        method: install.method,
        updateAvailable: Boolean(newer),
        error: s.error ?? null,
      });
    else if (s.error) io.out(`could not reach the registry: ${s.error}`);
    else
      io.out(
        newer
          ? `turno ${s.latest} is available (you have ${pkg.version}): turno upgrade`
          : `turno ${pkg.version} is the newest on ${channel}`,
      );
    return s.error ? 1 : 0;
  }

  if (isOneOff(install.method)) {
    // A copy in npx's (pnpm dlx's, bunx's) cache: nothing to replace, the runner fetches releases.
    const once = ONE_OFF_RUNNERS[install.method];
    io.out(`turno runs from ${once.runner}'s cache for this run: \`${once.latest}\` runs the newest release.`);
    io.out(`To keep turno, install it: ${once.install}`);
    return 0;
  }
  if (fromRegistry && off === "this copy is not published to a registry")
    fail("this copy is not published to a registry");
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
  if (!steps)
    return fail(`cannot tell how turno was installed (${install.root}); reinstall it with your package manager`);
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
  const finish = ["upgrade", "--finish", ...(yes ? ["--yes"] : [])];
  const r = spawnSync(
    install.method === "source" ? process.execPath : self,
    install.method === "source" ? [self, ...finish] : finish,
    { stdio: "inherit", env: io.env },
  );
  return r.status ?? 1;
}
