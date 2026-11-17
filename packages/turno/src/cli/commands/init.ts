import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { type AgentId, AGENT_IDS, DEFAULT_AGENT, adapter, agentHub, agentProfileDir, isAgentId, mcpFileFor } from "../../agents/index.js";
import { editConfig, migrationPending, MigrationPending, readConfigText } from "../../core/config-edit.js";
import { type Config, loadConfig, parseConfig } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { loadManifest, parseManifest } from "../../core/manifest.js";
import { expandHome, paths, tildify } from "../../core/paths.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import { addArrayTable, ensureTable, setValue } from "../../core/toml-edit.js";
import type { ImportReport } from "../../mcpd/importer.js";
import { DRY_RUN, type FlagSpec, bool, flagsOf, parseFlags, str } from "../args.js";
import { CliError, type Command, type Io, confirm, fail, paint, plural } from "../io.js";
import { launcherPath } from "../launch.js";
import { findOnPath, launcherName, refuseNpx } from "../launchers.js";
import { warnPath } from "./profile.js";
import { RESERVED, checkName, localCopies, setupProfiles } from "./setup.js";

/**
 * `turno init` (ADR 0030): one command in place of the quick start. It looks at the machine
 * (agents on PATH, turno profiles, agent folders made by hand, MCP servers in every agent config,
 * the folders each account was used in), proposes profiles, folder rules, a default and mcp.toml,
 * prints the whole change, and writes it through one journal so one `turno undo` reverts it.
 */

interface NewProfile {
  name: string;
  agent: AgentId;
  /** The folder existed before (made by hand): turno adopts it. */
  adopted: boolean;
}

interface Rule {
  /** Absolute folder. */
  path: string;
  profile: string;
}

type McpPlan =
  | { kind: "keep"; servers: number }
  | { kind: "skip" }
  | { kind: "none" }
  | { kind: "import"; summary: string; notes: string[]; report: ImportReport; servers: string[] };

interface Plan {
  agents: { id: AgentId; installed: boolean }[];
  existing: string[];
  profiles: NewProfile[];
  rules: Rule[];
  default?: string;
  mcp: McpPlan;
  notes: string[];
}

// Detection -----------------------------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `~/.claude-x`, `~/.codex-y`, ... that look like an agent home and are not turno profiles yet. */
function foundFolders(env: NodeJS.ProcessEnv, known: Set<string>, notes: string[]): NewProfile[] {
  const home = paths(env).home;
  let entries: string[] = [];
  try {
    entries = readdirSync(home).sort();
  } catch {
    return [];
  }
  const out: NewProfile[] = [];
  const taken = new Map<string, AgentId>();
  for (const agent of AGENT_IDS) {
    const prefix = adapter(agent).dirPrefix;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const name = entry.slice(prefix.length);
      const dir = join(home, entry);
      if (!isDir(dir) || !adapter(agent).homeMarkers.some((m) => existsSync(join(dir, m)))) continue;
      if (known.has(name)) continue;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || RESERVED.has(name)) {
        notes.push(`${tildify(dir, env)} looks like a ${adapter(agent).label} home, but "${name}" cannot be a profile name; left alone`);
        continue;
      }
      const other = taken.get(name);
      if (other) {
        notes.push(`${tildify(dir, env)}: a ${adapter(other).label} profile named ${name} is already proposed; add this one by hand with another name`);
        continue;
      }
      taken.set(name, agent);
      out.push({ name, agent, adopted: true });
    }
  }
  return out;
}

/**
 * Folder -> the accounts of the default agent it was used with ("" is the plain account of its
 * hub), from the folders its configs remember (Claude Code's `projects`).
 */
function folderOwners(env: NodeJS.ProcessEnv, profiles: string[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  const m = adapter(DEFAULT_AGENT).mcp;
  if (!m.foldersUsed) return owners;
  const add = (dir: string, who: string) => {
    const d = resolvePath(dir);
    owners.set(d, (owners.get(d) ?? new Set()).add(who));
  };
  for (const d of m.foldersUsed(m.hubFile(env))) add(d, "");
  for (const name of profiles) for (const d of m.foldersUsed(mcpFileFor(name, DEFAULT_AGENT, env))) add(d, name);
  return owners;
}

const within = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

/**
 * Folder rules from where each account was used: a folder (under HOME) used by exactly one
 * profile gets a rule for it. Two or more such folders side by side, under a parent that holds
 * no folder of anyone else, become one rule for the parent (never HOME itself). Folders an
 * existing rule already covers get nothing.
 */
export function inferRules(owners: Map<string, Set<string>>, home: string, ruled: string[], dirExists: (d: string) => boolean = isDir): Rule[] {
  const covered = (d: string) => ruled.some((r) => within(d, r));
  const only = (d: string) => {
    const s = owners.get(d);
    return s && s.size === 1 ? [...s][0]! : undefined;
  };
  const cand = new Map<string, string>();
  for (const dir of owners.keys()) {
    const who = only(dir);
    if (!who || !within(dir, home) || dir === home || !dirExists(dir) || covered(dir)) continue;
    cand.set(dir, who);
  }
  const byParent = new Map<string, string[]>();
  for (const dir of cand.keys()) byParent.set(dirname(dir), [...(byParent.get(dirname(dir)) ?? []), dir]);
  for (const [parent, kids] of byParent) {
    if (kids.length < 2 || !within(parent, home) || parent === home || covered(parent)) continue;
    const who = cand.get(kids[0]!)!;
    if (kids.some((k) => cand.get(k) !== who)) continue;
    if ([...owners.keys()].some((d) => within(d, parent) && only(d) !== who)) continue;
    for (const k of kids) cand.delete(k);
    cand.set(parent, who);
  }
  // A folder under another proposed folder of the same profile needs no rule of its own.
  for (const [dir, who] of [...cand]) {
    if ([...cand].some(([other, o]) => other !== dir && within(dir, other) && o === who)) cand.delete(dir);
  }
  return [...cand].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, profile]) => ({ path, profile }));
}

// Text diff -----------------------------------------------------------------------------------

/** Line diff of two texts (longest common subsequence): " " same, "+" added, "-" removed. */
export function lineDiff(before: string, after: string): [" " | "+" | "-", string][] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: [" " | "+" | "-", string][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push([" ", a[i]!]);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(["+", b[j++]!]);
    else out.push(["-", a[i++]!]);
  }
  return out;
}

/** The diff with two lines of context around each change; skipped runs show as "...". */
function printDiff(io: Io, before: string, after: string): void {
  const d = lineDiff(before, after);
  const near = d.map((_, k) => d.slice(Math.max(0, k - 2), k + 3).some(([op]) => op !== " "));
  let gap = false;
  for (const [k, [op, line]] of d.entries()) {
    if (!near[k]) {
      if (!gap) io.out("  ...");
      gap = true;
      continue;
    }
    gap = false;
    io.out(op === "+" ? paint(io, `+${line}`, "32") : op === "-" ? paint(io, `-${line}`, "31") : ` ${line}`);
  }
}

// Plan ----------------------------------------------------------------------------------------

const SPEC: FlagSpec = {
  ...DRY_RUN,
  yes: { type: "boolean", short: "y" },
  profile: { type: "string", multiple: true },
  skip: { type: "string", multiple: true },
  default: { type: "string" },
  "no-mcp": { type: "boolean" },
};

function list(p: { values: Record<string, unknown> }, name: string): string[] {
  const v = p.values[name];
  return Array.isArray(v) ? (v as string[]) : [];
}

/** `work`, `cx:codex`. */
function parseProfileArg(arg: string): NewProfile {
  const [name = "", agent = DEFAULT_AGENT, ...rest] = arg.split(":");
  if (rest.length || !isAgentId(agent)) fail(`--profile ${arg}: use <name> or <name>:<agent> (${AGENT_IDS.join(", ")})`);
  checkName(name);
  return { name, agent, adopted: false };
}

/** Yes unless the answer starts with n. */
async function askYes(io: Io, question: string): Promise<boolean> {
  const a = (await io.ask!(`${question} [Y/n] `)).trim().toLowerCase();
  return !a.startsWith("n");
}

async function mcpPlan(io: Io, skip: boolean): Promise<McpPlan> {
  if (skip) return { kind: "skip" };
  const file = paths(io.env).mcpFile;
  if (existsSync(file)) {
    let servers = 0;
    try {
      servers = Object.keys(loadManifest(io.env).servers).length;
    } catch {
      /* turno mcp list shows the error */
    }
    return { kind: "keep", servers };
  }
  const { collectSources, foundSummary, importServers, mergeSources } = await import("../../mcpd/importer.js");
  const { binOf } = await import("./mcp.js");
  const { sources, problems } = collectSources(io.env, process.cwd());
  for (const pr of problems) io.err(`${paint(io, "warning", "33")}: ${pr}`);
  const merged = mergeSources(sources);
  const names = Object.keys(merged.servers);
  if (!names.length) return { kind: "none" };
  const report = await importServers(merged.servers, { binOf: (pkg) => binOf(io, pkg) });
  parseManifest(report.toml); // never write something that cannot be read back
  return { kind: "import", summary: foundSummary(names, merged.from), notes: [...merged.notes, ...report.notes], report, servers: names };
}

async function makePlan(args: string[], io: Io, ask: boolean): Promise<{ plan: Plan; before: string; after: string }> {
  const p = parseFlags(args, SPEC, 0);
  const env = io.env;
  if (migrationPending(env)) throw new MigrationPending(env);
  const config = loadConfig(env);
  const existing = listProfiles(config, env);
  const notes: string[] = [];
  for (const n of existing) {
    const agent = agentOf(n, config);
    if (!existsSync(agentProfileDir(n, agent, env)) || !launcherPath(n, env, agent)) notes.push(`profile ${n} is not set up yet: turno profile repair ${n}`);
  }
  const agents = AGENT_IDS.map((id) => ({ id, installed: Boolean(findOnPath(adapter(id).command, env)) }));

  const skip = new Set(list(p, "skip"));
  const wanted = list(p, "profile").map(parseProfileArg);
  for (const w of wanted) if (existing.includes(w.name)) fail(`--profile ${w.name}: that profile exists already`);
  const known = new Set([...existing, ...wanted.map((w) => w.name)]);
  const profiles: NewProfile[] = [...wanted];
  for (const f of foundFolders(env, known, notes)) {
    if (skip.has(f.name)) continue;
    const dir = tildify(agentProfileDir(f.name, f.agent, env), env);
    if (ask && !(await askYes(io, `Use ${dir} as the ${adapter(f.agent).label} profile ${f.name}?`))) continue;
    profiles.push(f);
  }
  if (ask && !existing.length && !profiles.length) {
    const claudeHere = agents[0]!.installed || existsSync(paths(env).hub);
    const fallbackAgent = claudeHere ? undefined : agents.find((a) => a.installed)?.id;
    const suggestion = fallbackAgent ? `work:${fallbackAgent} personal:${fallbackAgent}` : "work personal";
    const answer = (await io.ask!(`Profiles to create (names; name:codex for another agent) [${suggestion}]: `)).trim() || suggestion;
    if (!/^none$/i.test(answer)) {
      for (const word of answer.split(/[\s,]+/).filter(Boolean)) {
        const np = parseProfileArg(word);
        if (!known.has(np.name)) profiles.push(np);
        known.add(np.name);
      }
    }
  }

  // Folder rules for profiles of the default agent, from the projects each account was used in.
  const claude = [...existing.filter((n) => agentOf(n, config) === DEFAULT_AGENT), ...profiles.filter((n) => n.agent === DEFAULT_AGENT).map((n) => n.name)];
  const ruled = config.projects.map((r) => resolvePath(expandHome(r.path, env)));
  const rules = inferRules(folderOwners(env, claude), paths(env).home, ruled);

  let def = str(p, "default");
  if (def !== undefined && !claude.includes(def)) fail(`--default ${def}: name a Claude Code profile (${claude.join(", ") || "none yet"})`);
  if (def === undefined && !config.default && ask && claude.length) {
    const suggestion = claude.includes("personal") ? "personal" : "none";
    const answer = (await io.ask!(`Default profile for folders without a rule (none: plain claude) [${suggestion}]: `)).trim() || suggestion;
    if (answer !== "none") {
      if (!claude.includes(answer)) fail(`${answer} is not a Claude Code profile here (${claude.join(", ")})`);
      def = answer;
    }
  }

  const mcp = await mcpPlan(io, bool(p, "no-mcp"));
  const plan: Plan = { agents, existing, profiles, rules, ...(def ? { default: def } : {}), mcp, notes };
  const before = readConfigText(env);
  return { plan, before, after: editText(before, plan, env) };
}

function editText(text: string, plan: Plan, env: NodeJS.ProcessEnv): string {
  let t = text;
  if (plan.default) t = setValue(t, undefined, "default", plan.default);
  for (const np of plan.profiles) {
    t = ensureTable(t, `profiles.${np.name}`);
    if (np.agent !== DEFAULT_AGENT) t = setValue(t, `profiles.${np.name}`, "agent", np.agent);
  }
  for (const r of plan.rules) t = addArrayTable(t, "projects", { path: tildify(r.path, env), profile: r.profile });
  return t;
}

// Output --------------------------------------------------------------------------------------

function printFound(io: Io, plan: Plan): void {
  const env = io.env;
  const label = (id: AgentId) => adapter(id).label;
  const installed = plan.agents.filter((a) => a.installed).map((a) => `${label(a.id)} (${adapter(a.id).command})`);
  const missing = plan.agents.filter((a) => !a.installed).map((a) => label(a.id));
  io.out("turno init found:");
  io.out(`  agents: ${installed.join(", ") || "none on PATH"}${missing.length ? `; not installed: ${missing.join(", ")}` : ""}`);
  if (plan.existing.length) io.out(`  turno profiles: ${plan.existing.join(", ")}`);
  const adopted = plan.profiles.filter((np) => np.adopted);
  if (adopted.length) io.out(`  agent folders made by hand: ${adopted.map((np) => tildify(agentProfileDir(np.name, np.agent, env), env)).join(", ")}`);
  const m = plan.mcp;
  if (m.kind === "keep") io.out(`  mcp.toml: ${tildify(paths(env).mcpFile, env)} with ${plural(m.servers, "server")} (kept as it is)`);
  else if (m.kind === "import") io.out(`  MCP servers: ${m.summary.replace(/^found /, "")}`);
  else if (m.kind === "none") io.out("  MCP servers: none in Claude Code, Codex, Cursor or Copilot CLI configs");
  for (const n of plan.notes) io.err(`  note: ${n}`);
}

/** What setting up each profile does to its folder: shared links, and own files moved aside. */
function printProfiles(io: Io, plan: Plan, config: Config): void {
  const env = io.env;
  if (!plan.profiles.length) return;
  const own = new Map(localCopies(plan.profiles.map((np) => np.name), env, config).map((x) => [x.name, x.items]));
  io.out("");
  io.out("Profiles:");
  for (const np of plan.profiles) {
    const dir = tildify(agentProfileDir(np.name, np.agent, env), env);
    const hub = tildify(agentHub(np.agent, env), env);
    io.out(`  + ${np.name} (${adapter(np.agent).label}): ${dir}${np.adopted ? " (exists)" : ""}, shared folders linked from ${hub}, command ${launcherName(np.name, np.agent)}`);
    const items = own.get(np.name) ?? [];
    if (items.length) io.out(`    ! moves your own ${items.join(", ")} to ${dir}/.aside-<time>/ (turno undo puts ${items.length === 1 ? "it" : "them"} back)`);
  }
}

function printPlan(io: Io, plan: Plan, before: string, after: string): void {
  const env = io.env;
  printFound(io, plan);
  printProfiles(io, plan, parseConfig(after, paths(env).configFile, env));
  if (after !== before) {
    io.out("");
    io.out(`${tildify(paths(env).configFile, env)}${before ? "" : " (new file)"}:`);
    printDiff(io, before, after);
  }
  if (plan.mcp.kind === "import") {
    const m = plan.mcp;
    io.out("");
    io.out(`${tildify(paths(env).mcpFile, env)} (new file, mode 600):`);
    for (const line of m.report.preview.replace(/\n$/, "").split("\n")) io.out(paint(io, `+${line}`, "32"));
    for (const n of m.notes) io.err(`  ${n}`);
    if (m.report.literalSecrets.length) {
      io.err(
        `  ${paint(io, "warning", "33")}: mcp.toml keeps literal secrets (${m.report.literalSecrets.join(", ")}); move them to the Keychain afterwards with: turno mcp import --write --move-secrets --force`,
      );
    }
  }
  if (!plan.default && !loadConfig(env).default && plan.profiles.some((np) => np.agent === DEFAULT_AGENT)) {
    io.out("");
    io.out("No default profile: folders without a rule open plain claude (set one with --default <profile>).");
  }
}

/** `codex-cx login`, `claude-work (then /login)`. */
function loginHint(agent: AgentId, command: string): string {
  const sub = adapter(agent).loginSubcommand;
  return sub ? `${command} ${sub}` : `${command} (then /login)`;
}

function printNext(io: Io, plan: Plan): void {
  const steps: string[] = [];
  if (plan.profiles.length) steps.push(`sign in once per profile where needed: ${plan.profiles.map((np) => loginHint(np.agent, launcherName(np.name, np.agent))).join(", ")}`);
  const hasServers = plan.mcp.kind === "import" || (plan.mcp.kind === "keep" && plan.mcp.servers > 0);
  if (hasServers) {
    steps.push("turno mcp daemon start   (the gateway, as a login service)");
    steps.push("turno mcp sync           (point every profile at it)");
  }
  steps.push("turno ui install         (optional: the status line and its font)");
  io.out("Next:");
  steps.forEach((s, i) => io.out(`  ${i + 1}. ${s}`));
}

// Command -------------------------------------------------------------------------------------

async function run(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, SPEC, 0);
  const dry = bool(p, "dry-run");
  const yes = bool(p, "yes");
  // Questions only when a person can answer and has not answered everything with --yes.
  const ask = !dry && !yes && Boolean(io.ask);
  const { plan, before, after } = await makePlan(args, io, ask);
  const writesMcp = plan.mcp.kind === "import";
  if (after === before && !writesMcp && !plan.profiles.length) {
    printFound(io, plan);
    io.out("");
    io.out("Nothing to set up: turno already knows this machine. turno doctor checks it.");
    return 0;
  }
  printPlan(io, plan, before, after);
  io.out("");
  if (dry) {
    io.out("Nothing written (dry run). turno init --yes writes all of it; one turno undo reverts it.");
    return 0;
  }
  // Launchers keep the path of this turno; a path into npx's cache disappears.
  if (plan.profiles.length) refuseNpx();
  if (!yes) {
    if (!io.ask) throw new CliError("turno init writes the changes above; run it in a terminal to confirm, or pass --yes");
    if (!(await confirm(io, "Write all of this?"))) {
      io.err("Nothing changed.");
      return 1;
    }
  }

  const env = io.env;
  const journal = new Journal(env, "init");
  // config.toml first: setting up a profile reads its agent from it.
  editConfig(env, journal, (text) => (text === before ? after : editText(text, plan, env)));
  if (plan.mcp.kind === "import") journal.write(paths(env).mcpFile, plan.mcp.report.toml, 0o600);
  if (plan.profiles.length) setupProfiles(plan.profiles.map((np) => np.name), io, { journal });
  io.out("");
  io.out(`Done. Undo all of it with: turno undo ${journal.stamp}`);
  const first = plan.profiles[0];
  if (first) warnPath(io, launcherName(first.name, first.agent));
  printNext(io, plan);
  return 0;
}

const USAGE = `Usage: turno init [--dry-run] [--yes] [--profile <name[:agent]>]... [--skip <name>]...
                  [--default <profile>] [--no-mcp]

Sets turno up in one step. It looks for installed agents, turno profiles, agent folders made by
hand (~/.claude-<name>, ~/.codex-<name>, ...), MCP servers in every agent config, and the
folders each Claude Code account was used in. Then it proposes profiles, folder rules, a default
and mcp.toml, prints the whole change, and writes it as one journal: turno undo <stamp> reverts
all of it. It never moves your own files without showing it first.

In a terminal it asks before adopting each folder, which profiles to create when there are none,
and the default; without one, --yes is required and flags give the answers.

  --dry-run            print the plan and the diff, write nothing
  -y, --yes            write without asking (adopts every folder found but those in --skip)
  --profile <p[:a]>    create this profile (agent claude, codex, copilot or cursor)
  --skip <name>        leave a found folder alone
  --default <p>        profile for folders without a rule
  --no-mcp             do not create mcp.toml

The gateway service and agent configs stay separate steps (turno mcp daemon start, then
turno mcp sync); init prints them at the end.`;

export const command: Command = {
  summary: "set turno up in one step: find agents, profiles, folders and MCP servers, show the diff, write it (one undo)",
  usage: USAGE,
  flags: flagsOf(SPEC),
  run,
};
