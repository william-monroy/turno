import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  type AgentId,
  AGENT_IDS,
  DEFAULT_AGENT,
  adapter,
  agentHub,
  agentProfileDir,
  isAgentId,
  mcpFileFor,
} from "../../agents/index.js";
import { editConfig, migrationPending, MigrationPending, readConfigText } from "../../core/config-edit.js";
import { type Config, loadConfig, parseConfig } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { loadManifest, parseManifest } from "../../core/manifest.js";
import { expandHome, paths, tildify } from "../../core/paths.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import { addArrayTable, ensureTable, setValue } from "../../core/toml-edit.js";
import type { ImportReport, ProfileSource } from "../../mcpd/importer.js";
import { DRY_RUN, type FlagSpec, bool, flagsOf, parseFlags, str } from "../args.js";
import { highlightTomlLine, tomlState } from "../highlight.js";
import { type Command, type Io, colors, confirm, fail, needsAnswer, paint, plural, wrap } from "../io.js";
import { type Style, duration, profileColor, spinner, style, visibleWidth } from "../style.js";
import { launcherPath } from "../launch.js";
import { findOnPath, launcherName, refuseNpx } from "../launchers.js";
import { resolveAll, warnPath } from "./profile.js";
import { RESERVED, checkName, localCopies, setupProfiles } from "./setup.js";

/**
 * `turno init`: one command in place of the quick start. It looks at the machine
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
  | {
      kind: "import";
      summary: string;
      notes: string[];
      report: ImportReport;
      servers: string[];
      merged: Record<string, Record<string, unknown>>;
    };

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
        notes.push(
          `${tildify(dir, env)} looks like a ${adapter(agent).label} home, but "${name}" cannot be a profile name; left alone`,
        );
        continue;
      }
      const other = taken.get(name);
      if (other) {
        notes.push(
          `${tildify(dir, env)}: a ${adapter(other).label} profile named ${name} is already proposed; add this one by hand with another name`,
        );
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
export function inferRules(
  owners: Map<string, Set<string>>,
  home: string,
  ruled: string[],
  dirExists: (d: string) => boolean = isDir,
): Rule[] {
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
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
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
  const st = style(io);
  const d = lineDiff(before, after);
  const near = d.map((_, k) => d.slice(Math.max(0, k - 2), k + 3).some(([op]) => op !== " "));
  // Added and unchanged lines are the new text in order: highlight them as one TOML text.
  const toml = tomlState();
  let gap = false;
  for (const [k, [op, line]] of d.entries()) {
    const shown = op === "-" || !colors(io) ? line : highlightTomlLine(line, toml);
    if (!near[k]) {
      if (!gap) io.out(paint(io, "      ...", "2"));
      gap = true;
      continue;
    }
    gap = false;
    io.out(
      op === "+"
        ? st.wrap(`    ${paint(io, "+", "32")}`, shown)
        : op === "-"
          ? st.wrap("    ", paint(io, `-${line}`, "31"))
          : st.wrap("     ", shown),
    );
  }
}

/** New text shown as all added lines: a green `+`, then the line highlighted as TOML. */
function printAdded(io: Io, text: string): void {
  const toml = tomlState();
  const st = style(io);
  for (const line of text.replace(/\n$/, "").split("\n"))
    io.out(st.wrap(`    ${paint(io, "+", "32")}`, colors(io) ? highlightTomlLine(line, toml) : line));
}

// Plan ----------------------------------------------------------------------------------------

const SPEC: FlagSpec = {
  ...DRY_RUN,
  yes: { type: "boolean", short: "y" },
  profile: { type: "string", multiple: true },
  skip: { type: "string", multiple: true },
  default: { type: "string" },
  "no-mcp": { type: "boolean" },
  start: { type: "boolean" },
  "no-start": { type: "boolean" },
};

function list(p: { values: Record<string, unknown> }, name: string): string[] {
  const v = p.values[name];
  return Array.isArray(v) ? (v as string[]) : [];
}

/** `work`, `cx:codex`. */
function parseProfileArg(arg: string): NewProfile {
  const [name = "", agent = DEFAULT_AGENT, ...rest] = arg.split(":");
  if (rest.length || !isAgentId(agent))
    fail(`--profile ${arg}: use <name> or <name>:<agent> (${AGENT_IDS.join(", ")})`);
  checkName(name);
  return { name, agent, adopted: false };
}

/** Yes unless the answer starts with n. */
async function askYes(io: Io, question: string): Promise<boolean> {
  const a = (await io.ask!(`${question} [Y/n] `)).trim().toLowerCase();
  return !a.startsWith("n");
}

/**
 * The mcp.toml init proposes. Offline: npx servers get a command name guessed from the package,
 * and `resolveMcp` asks npm for the real one only once the person has said to write.
 */
async function mcpPlan(io: Io, skip: boolean, profiles: readonly ProfileSource[]): Promise<McpPlan> {
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
  const { sources, problems } = collectSources(io.env, process.cwd(), profiles);
  for (const pr of problems) io.err(style(io).wrap("", `${paint(io, "warning", "33")}: ${pr}`));
  const merged = mergeSources(sources);
  const names = Object.keys(merged.servers);
  if (!names.length) return { kind: "none" };
  const report = await importServers(merged.servers);
  parseManifest(report.toml); // never write something that cannot be read back
  return {
    kind: "import",
    summary: foundSummary(names, merged.from),
    notes: [...merged.notes, ...report.notes],
    report,
    servers: names,
    merged: merged.servers,
  };
}

/** The manifest to write, with command names from npm (the only network call of init). */
async function resolveMcp(
  io: Io,
  plan: Extract<McpPlan, { kind: "import" }>,
): Promise<{ toml: string; notes: string[] }> {
  const { importServers } = await import("../../mcpd/importer.js");
  const { binOf } = await import("./mcp.js");
  const report = await importServers(plan.merged, { binOf: (pkg) => binOf(io, pkg) });
  parseManifest(report.toml);
  return { toml: report.toml, notes: report.notes.filter((n) => n.includes("npm did not name")) };
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
    if (!existsSync(agentProfileDir(n, agent, env)) || !launcherPath(n, env, agent))
      notes.push(`profile ${n} is not set up yet: turno profile repair ${n}`);
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
    const answer =
      (await io.ask!(`Profiles to create (names; name:codex for another agent) [${suggestion}]: `)).trim() ||
      suggestion;
    if (!/^none$/i.test(answer)) {
      for (const word of answer.split(/[\s,]+/).filter(Boolean)) {
        const np = parseProfileArg(word);
        if (!known.has(np.name)) profiles.push(np);
        known.add(np.name);
      }
    }
  }

  // Folder rules for profiles of the default agent, from the projects each account was used in.
  const claude = [
    ...existing.filter((n) => agentOf(n, config) === DEFAULT_AGENT),
    ...profiles.filter((n) => n.agent === DEFAULT_AGENT).map((n) => n.name),
  ];
  const ruled = config.projects.map((r) => resolvePath(expandHome(r.path, env)));
  const rules = inferRules(folderOwners(env, claude), paths(env).home, ruled);

  let def = str(p, "default");
  if (def !== undefined && !claude.includes(def))
    fail(`--default ${def}: name a Claude Code profile (${claude.join(", ") || "none yet"})`);
  if (def === undefined && !config.default && ask && claude.length) {
    const suggestion = claude.includes("personal") ? "personal" : "none";
    const answer =
      (await io.ask!(`Default profile for folders without a rule (none: plain claude) [${suggestion}]: `)).trim() ||
      suggestion;
    if (answer !== "none") {
      if (!claude.includes(answer)) fail(`${answer} is not a Claude Code profile here (${claude.join(", ")})`);
      def = answer;
    }
  }

  const folders: ProfileSource[] = [
    ...existing.map((name) => ({ name, agent: agentOf(name, config) })),
    ...profiles.filter((np) => np.adopted),
  ];
  const mcp = await mcpPlan(io, bool(p, "no-mcp"), folders);
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

const KEY = "not installed".length;

/** `  ✓ key       value`, the value wrapped under its column within the terminal width. */
function field(io: Io, st: Style, state: "ok" | "skip" | "info" | "warn", key: string, value: string): void {
  const lead = `  ${st.check(state, "")}`;
  const col = visibleWidth(lead) + KEY + 1;
  // Wrapped on a terminal; whole lines in a pipe, so a search finds them.
  const lines = st.color ? wrap(value, Math.max(30, st.width - col)) : [value];
  io.out(`${lead}${st.muted(key.padEnd(KEY))} ${lines[0]}`);
  for (const l of lines.slice(1)) io.out(`${" ".repeat(col)}${l}`);
}

function printFound(io: Io, plan: Plan, st: Style): void {
  const env = io.env;
  const label = (id: AgentId) => adapter(id).label;
  const installed = plan.agents.filter((a) => a.installed).map((a) => `${label(a.id)} (${adapter(a.id).command})`);
  const missing = plan.agents.filter((a) => !a.installed).map((a) => label(a.id));
  io.out(st.header("Found"));
  field(io, st, installed.length ? "ok" : "warn", "agents", installed.join(", ") || "none on PATH");
  if (missing.length) field(io, st, "skip", "not installed", missing.join(", "));
  if (plan.existing.length) field(io, st, "ok", "profiles", plan.existing.join(", "));
  const adopted = plan.profiles.filter((np) => np.adopted);
  if (adopted.length)
    field(
      io,
      st,
      "ok",
      "folders",
      `${adopted.map((np) => tildify(agentProfileDir(np.name, np.agent, env), env)).join(", ")} (made by hand)`,
    );
  const m = plan.mcp;
  if (m.kind === "keep")
    field(
      io,
      st,
      "ok",
      "mcp.toml",
      `${tildify(paths(env).mcpFile, env)} with ${plural(m.servers, "server")} (kept as it is)`,
    );
  else if (m.kind === "import") field(io, st, "ok", "MCP", m.summary.replace(/^found /, ""));
  else if (m.kind === "none") field(io, st, "skip", "MCP", "none in Claude Code, Codex, Cursor or Copilot CLI configs");
  for (const n of plan.notes) io.err(st.note("info", st.muted(`note: ${n}`)));
}

/** What setting up each profile does to its folder: shared links, and own files moved aside. */
function printProfiles(io: Io, plan: Plan, config: Config, st: Style): void {
  const env = io.env;
  if (!plan.profiles.length) return;
  const own = new Map(
    localCopies(
      plan.profiles.map((np) => np.name),
      env,
      config,
    ).map((x) => [x.name, x.items]),
  );
  const rows: string[][] = [];
  const asides = new Map<number, string>();
  for (const np of plan.profiles) {
    const dir = tildify(agentProfileDir(np.name, np.agent, env), env);
    const hub = tildify(agentHub(np.agent, env), env);
    rows.push([
      st.icon("add"),
      st.profile(np.name, profileColor(config.profiles, np.name)),
      adapter(np.agent).label,
      `${dir}${np.adopted ? st.muted(" (exists)") : ""}`,
      `${st.muted("command")} ${st.bold(launcherName(np.name, np.agent))}`,
      st.muted(`shares ${hub}`),
    ]);
    const items = own.get(np.name) ?? [];
    if (items.length)
      asides.set(
        rows.length - 1,
        `moves your own ${items.join(", ")} to ${dir}/.aside-<time>/ (turno undo puts ${items.length === 1 ? "it" : "them"} back)`,
      );
  }
  for (const [i, lines] of st.tableRows(rows, { columns: [{}, {}, { drop: 2 }, {}, {}, { drop: 3 }] }).entries()) {
    for (const line of lines) io.out(line);
    const aside = asides.get(i);
    if (aside) io.out(st.wrap(`      ${st.warn(st.icon("warn"))} `, st.muted(aside)));
  }
}

function printPlan(io: Io, plan: Plan, before: string, after: string, st: Style): void {
  const env = io.env;
  printFound(io, plan, st);
  io.out("");
  io.out(st.header("Plan"));
  printProfiles(io, plan, parseConfig(after, paths(env).configFile, env), st);
  if (after !== before) {
    io.out("");
    io.out(`  ${st.bold(tildify(paths(env).configFile, env))}${before ? "" : st.muted(" (new file)")}`);
    printDiff(io, before, after);
  }
  if (plan.mcp.kind === "import") {
    const m = plan.mcp;
    io.out("");
    io.out(`  ${st.bold(tildify(paths(env).mcpFile, env))}${st.muted(" (new file, mode 600)")}`);
    printAdded(io, m.report.preview);
    for (const n of groupNotes(m.notes)) io.err(st.note("info", st.muted(n)));
    if (m.report.literalSecrets.length) {
      io.err(
        st.note(
          "warn",
          `${st.warn("warning")}: mcp.toml keeps literal secrets (${m.report.literalSecrets.join(", ")}); move them to the Keychain afterwards with: turno mcp import --write --move-secrets --force`,
        ),
      );
    }
  }
  if (!plan.default && !loadConfig(env).default && plan.profiles.some((np) => np.agent === DEFAULT_AGENT)) {
    io.out("");
    io.out(
      st.wrap(
        "  ",
        st.muted("No default profile: folders without a rule open plain claude (set one with --default <profile>)."),
      ),
    );
  }
}

const SCOPE_UNKNOWN =
  'scope project: unknown server, one process per project folder; set scope = "shared" if it ignores its folder';

/**
 * Importer notes with the same text for several servers, as one note: `name: text` for one
 * server, `a, b: text` for more, and plain words for the common scope note.
 */
export function groupNotes(notes: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const n of notes) {
    const m = /^([\w.@/-]+): (.+)$/.exec(n);
    const key = m ? m[2]! : n;
    if (!groups.has(key)) order.push(key);
    groups.set(key, [...(groups.get(key) ?? []), ...(m ? [m[1]!] : [])]);
  }
  return order.map((text) => {
    const names = groups.get(text)!;
    if (!names.length) return text;
    if (names.length === 1) return `${names[0]}: ${text}`;
    if (text === SCOPE_UNKNOWN) {
      return `scope project for ${names.join(", ")} (unknown servers: one process per project folder; set scope = "shared" for those that ignore their folder)`;
    }
    return `${names.join(", ")}: ${text}`;
  });
}

/** `codex-cx login`, `claude-work (then /login)`. */
function loginHint(agent: AgentId, command: string): string {
  const sub = adapter(agent).loginSubcommand;
  return sub ? `${command} ${sub}` : `${command} (then /login)`;
}

/** Whether the plan leaves MCP servers for the gateway to serve. */
function hasServers(plan: Plan): boolean {
  return plan.mcp.kind === "import" || (plan.mcp.kind === "keep" && plan.mcp.servers > 0);
}

/**
 * The launcher to try first: the profile this folder now resolves to, when init made it or it
 * exists; else the first new profile.
 */
function tryLauncher(io: Io, plan: Plan): string | undefined {
  try {
    const config = loadConfig(io.env);
    const chosen = resolveAll(process.cwd(), config, io.env)[0]?.r.chosen;
    if (chosen && listProfiles(config, io.env).includes(chosen)) return launcherName(chosen, agentOf(chosen, config));
  } catch {
    /* fall back below */
  }
  const first = plan.profiles[0];
  return first ? launcherName(first.name, first.agent) : undefined;
}

function printNext(io: Io, plan: Plan, started: boolean, st: Style): void {
  const steps: [string, string][] = [];
  if (plan.profiles.length)
    steps.push([
      `sign in once per profile where needed: ${plan.profiles.map((np) => loginHint(np.agent, launcherName(np.name, np.agent))).join(", ")}`,
      "",
    ]);
  if (hasServers(plan) && !started) {
    steps.push(["turno mcp daemon start", "the gateway, as a login service"]);
    steps.push(["turno mcp sync", "point every profile at it"]);
  }
  steps.push(["turno ui install", "optional: the status line and its font"]);
  io.out(st.header("Next"));
  const w = Math.max(...steps.filter(([, why]) => why).map(([c]) => c.length));
  for (const [i, [cmd, why]] of steps.entries()) {
    if (why) io.out(`  ${st.muted(`${i + 1}.`)} ${st.bold(cmd.padEnd(w))}   ${st.muted(`(${why})`)}`);
    else
      for (const [k, l] of (st.color ? wrap(cmd, st.width - 5) : [cmd]).entries())
        io.out(`  ${k ? "  " : st.muted(`${i + 1}.`)} ${l}`);
  }
  const launcher = tryLauncher(io, plan);
  if (launcher) io.out(`\n${st.lead("next", `${st.bold("Try it:")} ${st.accent(launcher)}`)}`);
}

// Command -------------------------------------------------------------------------------------

async function run(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, SPEC, 0);
  const dry = bool(p, "dry-run");
  const yes = bool(p, "yes");
  if (bool(p, "start") && bool(p, "no-start")) fail("--start and --no-start do not go together");
  // Questions only when a person can answer and has not answered everything with --yes.
  const ask = !dry && !yes && Boolean(io.ask);
  const { plan, before, after } = await makePlan(args, io, ask);
  const st = style(io);
  const writesMcp = plan.mcp.kind === "import";
  if (after === before && !writesMcp && !plan.profiles.length) {
    printFound(io, plan, st);
    io.out("");
    io.out(st.lead("ok", "Nothing to set up: turno already knows this machine. turno doctor checks it."));
    return 0;
  }
  printPlan(io, plan, before, after, st);
  io.out("");
  // Start the gateway and connect the profiles in the same run: asked in a terminal (yes by
  // default), --start with --yes, never with --no-start. Both steps go in init's journal.
  let start = hasServers(plan) && bool(p, "start");
  if (hasServers(plan) && !bool(p, "no-start") && !bool(p, "start") && ask) {
    start = await askYes(
      io,
      "Also start the gateway and connect the profiles to it (turno mcp daemon start, turno mcp sync)?",
    );
  }
  if (dry) {
    if (start)
      io.out(
        st.wrap(
          "",
          "Then: start the gateway as a login service and point every profile at it (turno mcp daemon start, turno mcp sync).",
        ),
      );
    io.out(
      st.wrap(
        "",
        `${st.lead("info", "Nothing written (dry run).")} ${st.bold(`turno init --yes${hasServers(plan) ? " --start" : ""}`)} writes all of it; one turno undo reverts it.`,
      ),
    );
    return 0;
  }
  // Launchers keep the path of this turno; a path into npx's cache disappears.
  if (plan.profiles.length) refuseNpx();
  if (!yes) {
    if (!io.ask) needsAnswer("init");
    if (!(await confirm(io, "Write all of this?"))) {
      io.err("Nothing changed.");
      return 1;
    }
  }

  const env = io.env;
  const started = Date.now();
  const journal = new Journal(env, "init");
  io.out(st.header("Write"));
  // config.toml first: setting up a profile reads its agent from it.
  editConfig(env, journal, (text) => (text === before ? after : editText(text, plan, env)));
  io.out(`  ${st.check("ok", `wrote ${tildify(paths(env).configFile, env)}`)}`);
  if (plan.mcp.kind === "import") {
    const spin = spinner(io, "asking npm for the command names of MCP packages");
    let resolved: { toml: string; notes: string[] };
    try {
      resolved = await resolveMcp(io, plan.mcp);
    } finally {
      spin.stop();
    }
    journal.write(paths(env).mcpFile, resolved.toml, 0o600);
    io.out(
      `  ${st.check("ok", `wrote ${tildify(paths(env).mcpFile, env)} ${st.muted(`(${plural(plan.mcp.servers.length, "server")}, mode 600)`)}`)}`,
    );
    for (const n of resolved.notes) io.err(st.note("warn", st.muted(n), 4));
  }
  // Setup lines sit under the Write header.
  // Two columns narrower, so what setup wraps still fits after the indent.
  const indented: Io = {
    ...io,
    env: { ...io.env, COLUMNS: String(st.width - 2) },
    out: (line = "") => io.out(line ? line.replace(/^/gm, "  ") : line),
  };
  if (plan.profiles.length)
    setupProfiles(
      plan.profiles.map((np) => np.name),
      indented,
      { journal, brief: true },
    );
  let gatewayUp = false;
  if (start) {
    io.out("");
    io.out(st.header("Gateway"));
    const { startDaemonService } = await import("./mcpd.js");
    const { syncProfiles } = await import("./mcp.js");
    gatewayUp = (await startDaemonService(io, { journal })) === 0;
    io.out("");
    io.out(st.header("Sync"));
    await syncProfiles(io, { journal });
  }
  io.out("");
  io.out(
    st.wrap(
      st.color ? `${st.icon("ok")} ` : "ok ",
      `${st.bold("Done")} in ${duration(Date.now() - started)}. ${st.muted("Undo all of it with:")} ${st.bold(`turno undo ${journal.stamp}`)}`,
    ),
  );
  if (start) io.out(st.muted("  (the gateway keeps running until turno mcp daemon stop)"));
  const first = plan.profiles[0];
  if (first) warnPath(io, launcherName(first.name, first.agent));
  io.out("");
  printNext(io, plan, gatewayUp, st);
  return 0;
}

const USAGE = `Usage: turno init [--dry-run] [--yes] [--profile <name[:agent]>]... [--skip <name>]...
                  [--default <profile>] [--no-mcp] [--start | --no-start]

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
  --start              also start the gateway and point every profile at it (with --yes)
  --no-start           leave the gateway and the agent configs alone

When there are MCP servers, init in a terminal also offers to start the gateway as a login
service and point every profile at it (turno mcp daemon start, turno mcp sync), in the same
journal. With --yes it does that only with --start.

Examples:
  $ turno init
  $ turno init --dry-run
  $ turno init --yes --profile work --profile school:codex
  $ turno init --yes --no-mcp`;

export const command: Command = {
  summary:
    "set turno up in one step: find agents, profiles, folders and MCP servers, show the diff, write it (one undo)",
  usage: USAGE,
  flags: flagsOf(SPEC),
  run,
};
