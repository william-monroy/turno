import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { delimiter } from "node:path";
import { type AgentId, DEFAULT_AGENT, adapter, agentHub, agentProfileDir, isAgentId, AGENT_IDS } from "../../agents/index.js";
import { editConfig } from "../../core/config-edit.js";
import { type Config, type ProjectRule, loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { Journal } from "../../core/journal.js";
import { expandHome, paths, tildify } from "../../core/paths.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import { candidateRoots, folderMcpSet, resolveProfile } from "../../core/resolve.js";
import { type TomlValue, addArrayTable, ensureTable, removeArrayTables, removeTable, setValue } from "../../core/toml-edit.js";
import { NAMED_COLORS } from "../../statusline/render.js";
import { DRY_RUN, type FlagSpec, JSON_FLAG, bool, flagsOf, parseFlags, printJson, str } from "../args.js";
import { group } from "../group.js";
import { type Io, confirm, fail, needsAnswer, plural } from "../io.js";
import { findOnPath, launcherPath } from "../launch.js";
import { isGenerated, launcherName, refuseNpx } from "../launchers.js";
import { checkName, localCopies, setupProfiles } from "./setup.js";
import { authStatus } from "./usage.js";

/** A named color, or a 256-color code. */
export function parseColor(v: string, label = "--color"): string | number {
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 255) fail(`${label} ${v}: a 256-color code goes from 0 to 255`);
    return n;
  }
  if (NAMED_COLORS[v.toLowerCase()] === undefined) fail(`${label} ${v}: use a number (0-255) or one of ${Object.keys(NAMED_COLORS).join(", ")}`);
  return v.toLowerCase();
}

export async function profilesData(env: NodeJS.ProcessEnv, config: Config, withAccounts = true) {
  const names = listProfiles(config, env);
  // Account details come from `claude auth status`; other agents show whether they are set up.
  const auth = withAccounts ? await Promise.all(names.map((n) => (adapter(agentOf(n, config)).accountDetails ? authStatus(n, env) : undefined))) : [];
  return names.map((name, i) => {
    const s = auth[i];
    const agent = agentOf(name, config);
    const dir = agentProfileDir(name, agent, env);
    return {
      name,
      agent,
      dir: tildify(dir, env),
      setUp: existsSync(dir) && Boolean(launcherPath(name, env, agent)),
      ...(withAccounts ? { email: s?.loggedIn ? (s.email ?? null) : null, plan: s?.loggedIn ? (s.subscriptionType ?? null) : null } : {}),
      color: config.profiles[name]?.color ?? null,
      browser: config.profiles[name]?.browser ?? "chrome",
      roles: [config.system === name && "system", config.default === name && "default", config.fallback === name && "fallback"].filter(Boolean),
      projects: config.projects.filter((r) => r.profile === name).length,
      exhaustedUntil: exhaustedUntil(name, env) ?? null,
    };
  });
}

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const config = loadConfig(io.env);
  const rows = await profilesData(io.env, config);
  if (bool(p, "json")) {
    printJson(io, rows);
    return 0;
  }
  if (!rows.length) {
    io.out("No profiles yet. Create one with: turno profile add <name>");
    return 0;
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const who = r.setUp
      ? !adapter(r.agent).accountDetails
        ? `${adapter(r.agent).label} (${launcherName(r.name, r.agent)})`
        : r.email
          ? `${r.email}${r.plan ? ` · ${r.plan}` : ""}`
          : "not logged in"
      : `not set up (turno profile repair ${r.name})`;
    const extra = [r.roles.join(", "), r.projects ? plural(r.projects, "project") : "", r.exhaustedUntil ? "exhausted" : ""].filter(Boolean).join(" · ");
    io.out(`${r.name.padEnd(w)}  ${who}${extra ? `  (${extra})` : ""}`);
  }
  return 0;
}

/** The PATH line for a shell, or undefined when `dir` is on PATH. */
export function pathAdvice(env: NodeJS.ProcessEnv, dir = paths(env).bin): string | undefined {
  if ((env.PATH ?? "").split(delimiter).some((d) => d.replace(/\/+$/, "") === dir)) return undefined;
  const shell = (env.SHELL ?? "").split("/").pop();
  const shown = tildify(dir, env).replace(/^~/, "$HOME");
  if (shell === "fish") return `Add to ~/.config/fish/config.fish: fish_add_path ${shown.replace("$HOME", "~")}`;
  const rc = shell === "bash" ? "~/.bashrc" : "~/.zshrc";
  return `Add to ${rc}: export PATH="${shown}:$PATH"`;
}

/** Warn when the folder of the launchers is not on PATH, so `claude-<name>` would not be found. */
export function warnPath(io: Io, launcher: string): boolean {
  const advice = pathAdvice(io.env);
  if (!advice) return false;
  io.err(`warning: ${tildify(paths(io.env).bin, io.env)} is not on your PATH, so ${launcher} will not be found. ${advice}`);
  return true;
}

/**
 * Before moving the person's own files aside: ask in a terminal, or need --yes. Returns false
 * when the person said no.
 */
async function approveAside(cmd: string, names: string[], io: Io, yes: boolean): Promise<boolean> {
  const own = localCopies(names, io.env).filter((x) => x.items.length);
  if (!own.length || yes) return true;
  const text = own.map((x) => `${tildify(x.dir, io.env)} has its own ${x.items.join(", ")}`).join("; ");
  const what = `${text}. turno moves ${own.length === 1 && own[0]!.items.length === 1 ? "it" : "them"} to .aside-<time>/ in that folder and links the shared ones instead.`;
  io.err(what);
  if (!io.ask) needsAnswer(cmd);
  if (await confirm(io, "Go ahead?")) return true;
  io.err("Nothing changed.");
  return false;
}

const ADD_SPEC: FlagSpec = {
  agent: { type: "string" },
  color: { type: "string" },
  browser: { type: "string" },
  ...DRY_RUN,
  yes: { type: "boolean", short: "y" },
  verbose: { type: "boolean", short: "v" },
};

async function add(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, ADD_SPEC, 1);
  const name = p.positionals[0];
  if (!name) return fail(`usage: turno profile add <name> [--agent ${AGENT_IDS.join("|")}] [--color <c>] [--browser chrome|default]`);
  checkName(name);
  const agent = str(p, "agent") ?? DEFAULT_AGENT;
  if (!isAgentId(agent)) fail(`--agent must be one of ${AGENT_IDS.join(", ")}`);
  const color = str(p, "color");
  const parsedColor = color ? parseColor(color) : undefined;
  const browser = str(p, "browser");
  if (browser && browser !== "chrome" && browser !== "default") fail("--browser must be chrome or default");
  const dry = bool(p, "dry-run");
  if (!dry) {
    refuseNpx();
    if (!(await approveAside("profile add", [name], io, bool(p, "yes")))) return 1;
  }
  const journal = new Journal(io.env, `profile add ${name}`, dry);
  const table = `profiles.${name}`;
  const { changed } = editConfig(io.env, journal, (t) => {
    let text = ensureTable(t, table);
    if (agent !== DEFAULT_AGENT) text = setValue(text, table, "agent", agent);
    if (parsedColor !== undefined) text = setValue(text, table, "color", parsedColor);
    if (browser) text = setValue(text, table, "browser", browser);
    return text;
  });
  io.out(`${changed ? "+" : "="} [${table}] in ${tildify(paths(io.env).configFile, io.env)}${dry ? " (dry run)" : ""}`);
  const a = adapter(agent);
  if (!findOnPath(a.command, io.env)) io.err(`warning: ${a.command} is not installed yet (${a.install}); the profile works once it is`);
  if (dry) {
    io.out(`(dry run) would set up ${tildify(agentProfileDir(name, agent, io.env), io.env)} and the ${launcherName(name, agent)} command`);
    return 0;
  }
  // The same journal as the config.toml change: one `turno undo` reverts the whole profile add.
  setupProfiles([name], io, { verbose: bool(p, "verbose"), journal });
  const launcher = launcherName(name, agent);
  const offPath = warnPath(io, launcher);
  // `turno <name>` works without ~/.local/bin on PATH.
  const run = offPath ? `turno ${name}` : launcher;
  const sub = adapter(agent).loginSubcommand;
  io.out(`Next: ${sub ? `run ${run} ${sub}` : `run ${run} and sign in with /login`}. turno profile list shows the profile.`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

const REPAIR_SPEC: FlagSpec = { yes: { type: "boolean", short: "y" }, verbose: { type: "boolean", short: "v" } };

async function repair(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, REPAIR_SPEC);
  const names = p.positionals.length ? p.positionals : listProfiles(loadConfig(io.env), io.env);
  if (!names.length) return fail("no profiles to repair (turno profile add <name>)");
  for (const n of names) checkName(n);
  refuseNpx();
  if (!(await approveAside("profile repair", names, io, bool(p, "yes")))) return 1;
  setupProfiles(names, io, { verbose: bool(p, "verbose") });
  return 0;
}

async function remove(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const name = p.positionals[0];
  if (!name) return fail("usage: turno profile remove <name>");
  const config = loadConfig(io.env);
  if (!listProfiles(config, io.env).includes(name)) fail(`no profile '${name}'`);
  for (const role of ["system", "default", "fallback"] as const) {
    if (config[role] === name) fail(`${name} is the ${role} profile; point ${role} elsewhere first (turno config set ${role} <profile>)`);
  }
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile remove ${name}`, dry);
  let rules = 0;
  editConfig(io.env, journal, (t) => {
    const r = removeArrayTables(removeTable(t, `profiles.${name}`), "projects", (e) => e.profile === name);
    rules = r.removed;
    return keepSets(r.text, config.projects.filter((x) => x.profile === name), io.env);
  });
  const agent = agentOf(name, config);
  const launcher = launcherPath(name, io.env, agent);
  if (launcher && isGenerated(launcher)) journal.remove(launcher);
  const d = dry ? " (dry run)" : "";
  io.out(`- [profiles.${name}] and ${plural(rules, "project rule")} from config.toml${d}`);
  if (launcher) io.out(`- ${tildify(launcher, io.env)}${d}`);
  io.out(`${tildify(agentProfileDir(name, agent, io.env), io.env)} stays (sign-in, history); delete it by hand when you no longer need it.`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

/** The server set keys of a rule (ADR 0031), to write back when its profile part goes. */
function setKeys(rule: ProjectRule | undefined): Record<string, TomlValue> {
  return { ...(rule?.mcp ? { mcp: rule.mcp } : {}), ...(rule?.mcpDeny ? { mcp_deny: rule.mcpDeny } : {}) };
}

/** Write back, as rules of their own, the server sets of removed profile rules: the folder keeps them. */
function keepSets(text: string, removed: ProjectRule[], env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const r of removed) if (r.mcp || r.mcpDeny) out = addArrayTable(out, "projects", { path: tildify(r.path, env), ...setKeys(r) });
  return out;
}

/** "only docs, not mail": what a folder's server set lets sessions see. */
function setText(set: ProjectRule): string {
  const parts = [set.mcp ? `only ${set.mcp.join(", ") || "none"}` : "", set.mcpDeny ? `${set.mcp ? "not" : "all but"} ${set.mcpDeny.join(", ")}` : ""];
  return parts.filter(Boolean).join(", ");
}

function folder(arg: string | undefined, io: Io): string {
  const dir = resolvePath(expandHome(arg ?? process.cwd(), io.env));
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) fail(`no such folder: ${arg ?? dir}`);
  return dir;
}

/** How a folder resolves for each agent that has profiles (Claude Code always). */
/** Each agent's resolution of `dir`; `roots` is computed once (one git call) for all of them. */
export function resolveAll(dir: string, config: Config, env: NodeJS.ProcessEnv, roots: string[] = candidateRoots(dir)) {
  const agents = AGENT_IDS.filter((a) => a === DEFAULT_AGENT || listProfiles(config, env, a).length > 0);
  return agents.map((agent) => ({ agent, r: resolveProfile(dir, config, env, roots, agent) }));
}

/** "work (project ~/code)", or the plain agent and its home. */
export function usingText(agent: AgentId, r: { chosen: string; assigned: string; note: string; reason: string }, env: NodeJS.ProcessEnv): string {
  if (r.note) return `${r.chosen} (${r.assigned} ${r.note})`;
  return r.chosen ? `${r.chosen} (${r.reason})` : `plain ${adapter(agent).command} with ${tildify(agentHub(agent, env), env)} (${r.reason})`;
}

export async function whichCommand(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const dir = folder(p.positionals[0], io);
  const config = loadConfig(io.env);
  const roots = candidateRoots(dir);
  const all = resolveAll(dir, config, io.env, roots);
  const r = all[0]!.r;
  const set = folderMcpSet(roots, config.projects, r.chosen || undefined);
  if (bool(p, "json")) {
    const one = (x: typeof r) => ({ assigned: x.assigned || null, chosen: x.chosen || null, reason: x.reason, note: x.note || null });
    const mcp = set ? { rule: tildify(set.path, io.env), allow: set.mcp ?? null, deny: set.mcpDeny ?? null } : null;
    printJson(io, { dir: tildify(dir, io.env), ...one(r), agents: Object.fromEntries(all.map(({ agent, r: x }) => [agent, one(x)])), mcp });
    return 0;
  }
  io.out(tildify(dir, io.env));
  io.out(`  assigned: ${r.assigned || "none"} (${r.reason})`);
  io.out(r.note ? `  using now: ${r.chosen} (${r.assigned} ${r.note})` : `  using now: ${r.chosen || "plain claude"}`);
  for (const { agent, r: x } of all.slice(1)) io.out(`  ${agent}: ${usingText(agent, x, io.env)}`);
  if (set) io.out(`  mcp: ${setText(set)} (rule ${tildify(set.path, io.env)})`);
  return 0;
}

async function assign(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 2);
  const [dirArg, name] = p.positionals;
  if (!dirArg || !name) return fail("usage: turno profile assign <dir> <profile>");
  const dir = folder(dirArg, io);
  const config = loadConfig(io.env);
  if (!listProfiles(config, io.env).includes(name)) fail(`no profile '${name}' (turno profile list)`);
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile assign ${tildify(dir, io.env)} ${name}`, dry);
  const shown = tildify(dir, io.env);
  // One rule per folder and agent: a Codex rule does not replace the folder's Claude Code rule.
  // A rule with only a server set (ADR 0031) is not a profile rule and stays; a replaced rule
  // passes its set on to the new one.
  const agent = agentOf(name, config);
  const same = (e: { path?: string; profile?: string }) =>
    e.profile !== undefined && resolvePath(expandHome(e.path ?? "", io.env)) === dir && agentOf(e.profile, config) === agent;
  const carried = config.projects.find((r) => same(r) && (r.mcp || r.mcpDeny));
  editConfig(io.env, journal, (t) => addArrayTable(removeArrayTables(t, "projects", same).text, "projects", { path: shown, profile: name, ...setKeys(carried) }));
  io.out(`${shown} -> ${name}${dry ? " (dry run)" : ""}`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

async function unassign(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const dir = resolvePath(expandHome(p.positionals[0] ?? process.cwd(), io.env));
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile unassign ${tildify(dir, io.env)}`, dry);
  const config = loadConfig(io.env);
  // Profile rules only: the folder keeps its server set (ADR 0031).
  const own = (e: { path?: string; profile?: string }) => e.profile !== undefined && resolvePath(expandHome(e.path ?? "", io.env)) === dir;
  let removed = 0;
  editConfig(io.env, journal, (t) => {
    const r = removeArrayTables(t, "projects", own);
    removed = r.removed;
    return removed ? keepSets(r.text, config.projects.filter(own), io.env) : t;
  });
  if (!removed) {
    io.out(`${tildify(dir, io.env)} has no rule of its own (turno profile which explains what applies)`);
    return 1;
  }
  io.out(`${tildify(dir, io.env)} unassigned${dry ? " (dry run)" : ""}`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

export const command = group(
  "profile",
  "accounts (profiles) for each agent: list, add, repair, remove, and which folders use each",
  {
    list: { summary: "each profile, its account and roles", synopsis: "[--json]", flags: ["--json"], run: list },
    add: {
      summary:
        "declare a profile in config.toml and set up its folder and launcher (claude-<name>, codex-<name>, ...); asks before moving your own files aside (--yes skips the question), -v lists every shared item; turno undo reverts all of it",
      synopsis: "<name> [--agent claude|codex|copilot|cursor] [--color <c>] [--browser chrome|default] [--dry-run] [--yes] [-v]",
      args: ["any"],
      flags: flagsOf(ADD_SPEC),
      run: add,
    },
    repair: {
      summary: "relink shared folders and rewrite launchers (all profiles by default); turno undo reverts it",
      synopsis: "[profile...] [--yes] [-v]",
      args: ["profile"],
      flags: flagsOf(REPAIR_SPEC),
      run: repair,
    },
    remove: {
      summary: "drop a profile from config.toml and its launcher (its folder stays)",
      synopsis: "<name> [--dry-run]",
      args: ["profile"],
      flags: ["--dry-run"],
      run: remove,
    },
    which: { summary: "which profile auto uses in a folder for each agent, and why", synopsis: "[dir] [--json]", args: ["dir"], flags: ["--json"], run: whichCommand },
    assign: { summary: "make a folder (and everything under it) use a profile", synopsis: "<dir> <profile> [--dry-run]", args: ["dir", "profile"], flags: ["--dry-run"], run: assign },
    unassign: { summary: "remove a folder's own rule", synopsis: "[dir] [--dry-run]", args: ["dir"], flags: ["--dry-run"], run: unassign },
  },
  { fallback: "list" },
);
