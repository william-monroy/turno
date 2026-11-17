import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { JSON_MCP_SERVERS, TOML_MCP_SERVERS } from "../../agents/adapter.js";
import { agentProfileDir } from "../../agents/index.js";
import { type Config, loadConfig, parseConfig } from "../../core/config.js";
import { Journal, listJournals } from "../../core/journal.js";
import { paths, tildify } from "../../core/paths.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import type { ServiceBackend } from "../../mcpd/service.js";
import { profileTokenFile } from "../../mcpd/tokens.js";
import { type StatusLine, currentStatusLine, isTurnoStatusLine, readSettings } from "../../ui/settings.js";
import { DRY_RUN, bool, parseFlags } from "../args.js";
import { CliError, type Command, type Io, confirm } from "../io.js";
import { MARKER } from "../launchers.js";
import { realOr } from "../../core/fsutil.js";

/**
 * `turno uninstall` (ADR 0025): remove everything turno set up outside its package, through
 * one journal, so `turno undo <stamp>` puts it back while turno is still installed. It never
 * deletes a profile folder (they hold logins), turno's backups, or anything turno did not write.
 */

const USAGE = `Usage: turno uninstall [--dry-run] [--yes] [--keep-config]

Removes what turno set up on this machine, then tells you the command that
removes the package itself:
  - the mcpd service (LaunchAgent or systemd user unit), and stops mcpd
  - the MCP entries turno mcp sync added to agent configs (your own entries stay)
  - the status line turno ui install set (the one you had before comes back)
  - the launchers turno wrote in ~/.local/bin (claude-<name>, turno-auto, ...)
  - turno's fish completion file, and the gateway token
  - ~/.config/turno (config.toml, mcp.toml, accounts.toml), unless --keep-config

Profile folders (~/.claude-<name> and the like) hold your logins and history:
they stay, and the list says where they are. So do turno's backups under
~/.local/state/turno, which let \`turno undo <stamp>\` put everything back
before you remove the package. Lines that load turno in your shell startup
files are listed for you to remove by hand.

  --dry-run      print the list and change nothing
  --yes          do not ask (needed when there is no terminal to ask in)
  --keep-config  keep ~/.config/turno`;

interface ConfigFiles {
  root: string;
  files: string[];
  links: string[];
  /** Deepest first, the root last. */
  dirs: string[];
}

export interface UninstallPlan {
  service?: { backend: ServiceBackend; file: string };
  daemonPid?: number;
  /** Agent config files and the managed server names still in each. */
  configs: { file: string; names: string[] }[];
  managedFile?: string;
  statusLine?: { file: string; restore?: StatusLine };
  launchers: string[];
  completions: string[];
  token?: string;
  /** Per-profile gateway token files (ADR 0023). */
  profileTokens: string[];
  turnoConfig?: ConfigFiles;
  /** Shell startup lines to remove by hand. */
  manual: string[];
  /** What stays, one line each. */
  kept: string[];
}

function lstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

function safeConfig(env: NodeJS.ProcessEnv): Config {
  try {
    return loadConfig(env);
  } catch {
    return parseConfig("", paths(env).configFile, env);
  }
}

/** Server names of an agent config file: `mcpServers` in JSON, `[mcp_servers.*]` in a Codex config.toml. */
function serverNames(file: string): string[] {
  try {
    const text = readFileSync(file, "utf8");
    const servers = file.endsWith(".toml") ? (parseToml(text) as Record<string, unknown>).mcp_servers : (JSON.parse(text) as Record<string, unknown>).mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/** Launchers turno wrote: regular files in the launcher folder that carry its marker. */
function turnoLaunchers(env: NodeJS.ProcessEnv): string[] {
  const bin = paths(env).bin;
  let names: string[] = [];
  try {
    names = readdirSync(bin).sort();
  } catch {
    return [];
  }
  return names
    .map((n) => join(bin, n))
    .filter((f) => {
      if (!lstat(f)?.isFile()) return false;
      try {
        return readFileSync(f, "utf8").slice(0, 400).includes(MARKER);
      } catch {
        return false;
      }
    });
}

/**
 * The status line to put back: the one the settings file had before the newest `ui install`
 * that changed it to turno's, or none when it had none.
 */
function statusLineBefore(file: string, env: NodeJS.ProcessEnv): StatusLine | undefined {
  const target = realOr(file);
  for (const j of listJournals(env)) {
    if (!j.manifest?.command.startsWith("ui install")) continue;
    const e = j.manifest.entries.find((x) => (x.kind ?? "file") === "file" && x.path === target);
    if (!e) continue;
    if (!e.existed || !e.backup) return undefined;
    let before: StatusLine | undefined;
    try {
      before = (JSON.parse(readFileSync(join(j.dir, e.backup), "utf8")) as Record<string, unknown>).statusLine as StatusLine | undefined;
    } catch {
      return undefined;
    }
    if (!before || typeof before !== "object") return undefined;
    if (!isTurnoStatusLine(before)) return before;
  }
  return undefined;
}

function walk(root: string): ConfigFiles | undefined {
  if (!lstat(root)?.isDirectory()) return undefined;
  const out: ConfigFiles = { root, files: [], links: [], dirs: [] };
  const visit = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      const st = lstat(p);
      if (st?.isSymbolicLink()) out.links.push(p);
      else if (st?.isDirectory()) visit(p);
      else if (st?.isFile()) out.files.push(p);
    }
    out.dirs.push(dir);
  };
  visit(root);
  return out;
}

const RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];

export async function planUninstall(env: NodeJS.ProcessEnv, opts: { keepConfig?: boolean } = {}): Promise<UninstallPlan> {
  const p = paths(env);
  const plan: UninstallPlan = { configs: [], launchers: [], completions: [], profileTokens: [], manual: [], kept: [] };

  // Only a service whose file is in this HOME: never ask the service manager about one it is not.
  const { installedBackend } = await import("../../mcpd/service.js");
  const backend = await installedBackend(env);
  if (backend) plan.service = { backend, file: backend.file(env) };
  const { liveLock } = await import("../../mcpd/daemon.js");
  const lock = liveLock(env);
  if (lock && lock.pid !== process.pid) plan.daemonPid = lock.pid;

  const { readManaged } = await import("../../mcpd/sync.js");
  const managed = readManaged(p.mcpdManaged);
  for (const [file, names] of Object.entries(managed)) {
    if (!existsSync(file)) continue;
    const present = new Set(serverNames(file));
    const mine = names.filter((n) => present.has(n));
    if (mine.length) plan.configs.push({ file, names: mine });
  }
  if (existsSync(p.mcpdManaged)) plan.managedFile = p.mcpdManaged;

  const settings = join(p.hub, "settings.json");
  if (isTurnoStatusLine(currentStatusLine(settings))) {
    const restore = statusLineBefore(settings, env);
    plan.statusLine = { file: settings, ...(restore ? { restore } : {}) };
  }

  plan.launchers = turnoLaunchers(env);

  const fish = join(env.XDG_CONFIG_HOME || join(p.home, ".config"), "fish", "completions", "turno.fish");
  try {
    if (lstat(fish)?.isFile() && readFileSync(fish, "utf8").includes("turno __complete")) plan.completions.push(fish);
  } catch {
    /* unreadable: leave it */
  }
  for (const rc of RC_FILES) {
    const file = join(p.home, rc);
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    lines.forEach((l, i) => {
      if (/\bturno\s+completion\b/.test(l)) plan.manual.push(`${tildify(file, env)} line ${i + 1}: ${l.trim()}`);
    });
  }

  if (existsSync(p.mcpdToken)) plan.token = p.mcpdToken;
  const tokenDir = dirname(profileTokenFile("x", env));
  if (existsSync(tokenDir)) {
    for (const f of readdirSync(tokenDir)) if (f.endsWith(".token")) plan.profileTokens.push(join(tokenDir, f));
  }

  if (opts.keepConfig) {
    if (existsSync(p.config)) plan.kept.push(`${tildify(p.config, env)} stays (--keep-config)`);
  } else {
    const c = walk(p.config);
    if (c) plan.turnoConfig = c;
  }

  const config = safeConfig(env);
  for (const name of listProfiles(config, env)) {
    const dir = agentProfileDir(name, agentOf(name, config), env);
    if (existsSync(dir)) plan.kept.push(`${tildify(dir, env)} (profile ${name}: its login and history) stays; delete it by hand when you no longer need it`);
  }
  if (existsSync(p.chromeProfilesDir)) plan.kept.push(`${tildify(p.chromeProfilesDir, env)} (browser profiles with their logins) stays`);
  if (existsSync(p.data)) plan.kept.push(`${tildify(p.data, env)} (installed MCP servers, caches) stays`);
  plan.kept.push(`${tildify(p.state, env)} (backups for turno undo, logs) stays`);
  plan.kept.push("secrets you stored with turno secret stay in the Keychain or Secret Service (turno secret --help)");
  return plan;
}

function isEmpty(plan: UninstallPlan): boolean {
  return (
    !plan.service &&
    !plan.daemonPid &&
    !plan.configs.length &&
    !plan.statusLine &&
    !plan.launchers.length &&
    !plan.completions.length &&
    !plan.token &&
    !plan.profileTokens.length &&
    !plan.turnoConfig
  );
}

function describe(plan: UninstallPlan, env: NodeJS.ProcessEnv): string[] {
  const t = (p: string) => tildify(p, env);
  const out: string[] = [];
  if (plan.service) out.push(`the mcpd ${plan.service.backend.noun} ${t(plan.service.file)}`);
  if (plan.daemonPid) out.push(`stop mcpd (pid ${plan.daemonPid})`);
  for (const c of plan.configs) out.push(`MCP entries turno added: ${c.names.join(", ")} from ${t(c.file)}`);
  if (plan.statusLine) {
    const back = plan.statusLine.restore ? `; your earlier one comes back: ${plan.statusLine.restore.command}` : "";
    out.push(`the statusLine turno set in ${t(plan.statusLine.file)}${back}`);
  }
  for (const l of plan.launchers) out.push(`launcher ${t(l)}`);
  for (const c of plan.completions) out.push(`completion ${t(c)}`);
  if (plan.token) out.push(`the gateway token ${t(plan.token)}`);
  if (plan.profileTokens.length) out.push(`${plan.profileTokens.length} profile gateway token file${plan.profileTokens.length === 1 ? "" : "s"} in ${t(dirname(plan.profileTokens[0]!))}`);
  if (plan.turnoConfig) {
    const names = plan.turnoConfig.files.map((f) => f.slice(plan.turnoConfig!.root.length + 1));
    out.push(`${t(plan.turnoConfig.root)}${names.length ? ` (${names.join(", ")})` : ""}`);
  }
  return out;
}

/** The command that removes the package: Homebrew when this turno runs from a Cellar, else npm. */
export function packageRemoval(argv1: string | undefined = process.argv[1]): string {
  const file = argv1 ? realOr(argv1) : "";
  return /\/Cellar\/|\/homebrew\//i.test(file) ? "brew uninstall turno" : "npm uninstall --global turno-cli";
}

async function apply(plan: UninstallPlan, journal: Journal, io: Io): Promise<void> {
  const env = io.env;
  const { ServiceError } = await import("../../mcpd/service.js");
  if (plan.service) {
    const { removeService } = await import("../../mcpd/service.js");
    try {
      await removeService(plan.service.backend, env, journal);
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      // The file still goes, so the service does not come back at the next login.
      io.err(`turno: warning: ${err.message}`);
      if (existsSync(plan.service.file)) journal.remove(plan.service.file);
    }
  }
  if (plan.daemonPid) {
    const { liveLock } = await import("../../mcpd/daemon.js");
    try {
      process.kill(plan.daemonPid, "SIGTERM");
    } catch {
      /* gone already */
    }
    for (let waited = 0; waited < 5000 && liveLock(env); waited += 250) await new Promise((r) => setTimeout(r, 250));
  }
  if (plan.configs.length) {
    const { syncServers } = await import("../../mcpd/sync.js");
    for (const c of plan.configs) {
      const at = journal.save(c.file);
      syncServers(c.file, c.file.endsWith(".toml") ? TOML_MCP_SERVERS : JSON_MCP_SERVERS, {}, c.names);
      journal.settle(at);
    }
  }
  if (plan.managedFile && existsSync(plan.managedFile)) journal.remove(plan.managedFile);
  if (plan.statusLine) {
    const settings = readSettings(plan.statusLine.file);
    if (plan.statusLine.restore) settings.statusLine = plan.statusLine.restore;
    else delete settings.statusLine;
    journal.write(plan.statusLine.file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  for (const l of plan.launchers) journal.remove(l);
  for (const c of plan.completions) journal.remove(c);
  if (plan.token) journal.remove(plan.token);
  for (const f of plan.profileTokens) journal.remove(f);
  if (plan.turnoConfig) {
    for (const f of plan.turnoConfig.files) journal.remove(f);
    for (const l of plan.turnoConfig.links) journal.unlink(l);
    for (const d of plan.turnoConfig.dirs) {
      try {
        journal.rmdir(d);
      } catch {
        io.err(`turno: warning: ${tildify(d, env)} holds something turno cannot remove; it stays`);
      }
    }
  }
}

export const command: Command = {
  summary: "remove the service, launchers, status line and MCP entries turno set up (profile folders stay)",
  usage: USAGE,
  flags: ["--dry-run", "--yes", "--keep-config"],
  async run(args, io) {
    const p = parseFlags(args, { ...DRY_RUN, yes: { type: "boolean", short: "y" }, "keep-config": { type: "boolean" } }, 0);
    const dry = bool(p, "dry-run");
    const plan = await planUninstall(io.env, { keepConfig: bool(p, "keep-config") });
    const remove = describe(plan, io.env);
    const last = `Last step, to remove the package: ${packageRemoval()}`;
    const printStays = () => {
      if (plan.manual.length) {
        io.out("Remove by hand (turno does not edit shell startup files):");
        for (const m of plan.manual) io.out(`  - ${m}`);
      }
      io.out("Stays:");
      for (const k of plan.kept) io.out(`  - ${k}`);
    };
    if (isEmpty(plan)) {
      io.out("Nothing of turno's to remove on this machine.");
      printStays();
      io.out(last);
      return 0;
    }
    io.out(dry ? "turno uninstall would remove:" : "turno uninstall removes:");
    for (const r of remove) io.out(`  - ${r}`);
    printStays();
    if (dry) {
      io.out(last);
      return 0;
    }
    if (!bool(p, "yes")) {
      if (!io.ask) throw new CliError("turno uninstall changes the files above; run it in a terminal to confirm, or pass --yes");
      if (!(await confirm(io, "Remove all of this?"))) {
        io.err("Nothing changed.");
        return 1;
      }
    }
    const journal = new Journal(io.env, `uninstall${bool(p, "keep-config") ? " --keep-config" : ""}`);
    await apply(plan, journal, io);
    io.out("Done.");
    if (journal.used) {
      io.out(`Changed your mind? turno undo ${journal.stamp} puts it all back while turno is still installed (then turno mcp daemon start).`);
    }
    io.out(last);
    return 0;
  },
};
